import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { cors } from 'hono/cors';
import { extractFromPdf, chatWithGemini } from './vertexAi.js';
import { generateExcel } from './excelService.js';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

const app = new Hono();

app.use('*', cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'Authorization', 'Cf-Access-Authenticated-User-Email', 'X-User-Email'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
// Global Error Handler to ensure CORS headers are always present
app.onError((err, c) => {
    console.error('Unhandled Error:', err);
    // Explicitly add CORS headers for browsers
    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cf-Access-Authenticated-User-Email');

    return c.json({
        error: 'Internal Server Error',
        message: err.message,
        stack: err.stack,
    }, 500, Object.fromEntries(headers));
});

// Helper to get user email and log usage
async function logUsage(env, c, eventType, tokens, fileCount = 0) {
    try {
        const userEmail = c.req.header('X-User-Email') || c.req.header('Cf-Access-Authenticated-User-Email') || 'anonymous@internal.com';
        await env.DB.prepare(
            'INSERT INTO usage_logs (user_email, event_type, token_input, token_output, token_total, file_count) VALUES (?, ?, ?, ?, ?, ?)'
        )
            .bind(userEmail, eventType, tokens.input || 0, tokens.output || 0, tokens.total || 0, fileCount)
            .run();
    } catch (error) {
        console.error('Logging error:', error);
    }
}

app.get('/', (c) => {
    return c.json({ status: 'API is running', version: '2.0.1 (Cloudflare Native)' });
});

// Test Endpoint for Vertex AI
app.get('/api/test-vertex', async (c) => {
    try {
        const text = 'Say hello in 5 words.';
        const result = await extractFromPdf(null, text, c.env);
        return c.json({ success: true, result });
    } catch (error) {
        return c.json({
            success: false,
            error: error.message,
            stack: error.stack,
            env_check: {
                has_project: !!c.env.GOOGLE_CLOUD_PROJECT,
                has_location: !!c.env.GOOGLE_CLOUD_LOCATION,
                has_creds: !!c.env.GOOGLE_APPLICATION_CREDENTIALS
            }
        }, 500);
    }
});

// Extract PDF Data
app.post('/api/extract', async (c) => {
    try {
        const body = await c.req.parseBody();
        const pdfFile = body.file; // Matches frontend
        const customPrompt = body.prompt;
        const temperature = body.temperature !== undefined ? parseFloat(body.temperature) : 0.0;

        if (!pdfFile || !(pdfFile instanceof File)) {
            return c.json({ error: 'No file uploaded' }, 400);
        }

        const arrayBuffer = await pdfFile.arrayBuffer();
        const pdfBase64 = Buffer.from(arrayBuffer).toString('base64');

        const { data, usage } = await extractFromPdf(pdfBase64, customPrompt, temperature, c.env);

        // Log usage for analytics
        await logUsage(c.env, c, 'extraction', {
            input: usage.promptTokenCount,
            output: usage.candidatesTokenCount,
            total: usage.totalTokenCount
        }, 1);

        return c.json({ data, usage });
    } catch (error) {
        console.error('Extraction error:', error);
        return c.json({
            error: 'Server Error during extraction',
            details: error.message,
            stack: error.stack // Helpful for debugging in the browser console
        }, 500);
    }
});

// Download Excel
app.post('/api/download-excel', async (c) => {
    try {
        const { data } = await c.req.json();
        if (!data || !Array.isArray(data)) {
            return c.json({ error: 'Invalid data' }, 400);
        }

        const buffer = await generateExcel(data);

        return new Response(buffer, {
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': 'attachment; filename=extracted_data.xlsx',
            },
        });
    } catch (error) {
        console.error('Excel error:', error);
        return c.json({ error: error.message }, 500);
    }
});

// AI Excel Merger
import { processExcelMerge } from './excelGroupParser.js';
import * as XLSX from 'xlsx';

app.post('/api/merge-excel', async (c) => {
    try {
        const body = await c.req.parseBody();
        const excelFile = body.file;
        
        if (!excelFile || !(excelFile instanceof File)) {
            return c.json({ error: 'No Excel file uploaded' }, 400);
        }

        const arrayBuffer = await excelFile.arrayBuffer();
        
        // Return a Server-Sent Events Stream for live updates
        return stream(c, async (streamWriter) => {
            const emit = async (type, data) => {
                 await streamWriter.write(`data: ${JSON.stringify({ type, data })}\n\n`);
            };

            try {
                await emit('progress', { message: 'Grouping original questions...' });
                // 1. Group the questions
                const parsedData = await processExcelMerge(arrayBuffer);
                
                // 2. Prepare for Restore AI Call
                const defaultPrompt = `You are a strict clinical AI medical editor. 
You will receive a JSON array of sub-questions. Each object has an 'id', 'group_id', 'q_num', and 'q_text'.
Objects with the strict SAME 'group_id' belong to the same parent question and appear in sequential order.
CRITICAL INSTRUCTIONS:
1. Evaluate each 'q_text' individually to decide if it is 'Complete' or 'Incomplete'.
2. What is COMPLETE: Any statement that already contains the name of the specific disease, drug, or clinical condition is COMPLETE. If you can read the sentence and immediately know the exact medical noun being discussed, it is COMPLETE. 
   Examples of COMPLETE: "Clinical presentation of senile osteoporosis.", "Fracture healing.", "Screening of patients prior to starting biological therapy in immunobullous disorder.", "Management of Hemangioma."
   If it is COMPLETE, set status to 'Complete' and return the EXACT ORIGINAL 'q_text' as 'restored_text'. Do not change a single letter.
3. What is INCOMPLETE: A question is ONLY INCOMPLETE if it uses a vague pronoun ("it", "they", "this", "that") OR completely lacks the core disease noun (e.g. "Clinical features and diagnostic criteria.", "Management of it.", "How would you investigate?").
4. REWRITING INCOMPLETE QUESTIONS: If you mark it 'Incomplete', you MUST read the preceding question with the SAME 'group_id'. Find the missing disease/noun from the preceding question, and rewrite the incomplete question to include it.
   Example: If 1a="Classify osteoporosis" and 1b="Clinical features.", you must return 'restored_text' as "Clinical features of osteoporosis." and status as 'Incomplete'.
5. You MUST output EVERY single 'id' provided in the batch. Do not drop any items.
Return ONLY a valid JSON array containing EXACTLY these keys: {"id": <int>, "status": "<Complete or Incomplete>", "restored_text": "<val>"}`;

                const systemPrompt = body.systemPrompt || defaultPrompt;

        let globalIndex = 0;
        const flattenGroups = [];
        parsedData.orderedRoots.forEach(r => {
            parsedData.groups[r].forEach(item => {
                globalIndex++;
                flattenGroups.push({
                   id: globalIndex,
                   group_id: r,
                   q_num: item.q_num,
                   q_text: item.q_text
                });
                item._id = globalIndex; // Attach unique ID to the original parsed item
            });
        });
        
        // Batch Processing
        let batchSize = 10;
        if (body.batchSize) {
            batchSize = parseInt(body.batchSize, 10);
            if (isNaN(batchSize) || batchSize < 1) batchSize = 1;
            if (batchSize > 100) batchSize = 100;
        }

        let allMergedResults = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        
        for (let i = 0; i < flattenGroups.length; i += batchSize) {
             const batch = flattenGroups.slice(i, i + batchSize);
             const batchNum = Math.floor(i / batchSize) + 1;
             const totalBatches = Math.ceil(flattenGroups.length / batchSize);
             await emit('progress', { message: `Processing batch ${batchNum} of ${totalBatches} (rows ${i + 1}–${Math.min(i + batchSize, flattenGroups.length)})...` });
             
             const messages = [
                 { role: 'user', content: JSON.stringify(batch) }
             ];

             // Retry loop: up to 3 attempts per batch
             let attempts = 0;
             let batchSuccess = false;
             while (attempts < 3 && !batchSuccess) {
                 attempts++;
                 try {
                     const aiRes = await chatWithGemini(messages, [], systemPrompt, c.env);
                     let mergedResult = JSON.parse(aiRes.reply.replace(/```json|```/g, '').trim());
                     if (!Array.isArray(mergedResult)) { mergedResult = [mergedResult]; }
                     allMergedResults.push(...mergedResult);
                     totalInputTokens += aiRes.usage?.promptTokenCount || 0;
                     totalOutputTokens += aiRes.usage?.candidatesTokenCount || 0;
                     batchSuccess = true;
                 } catch (e) {
                     const isRateLimit = e.message && (e.message.includes('429') || e.message.toLowerCase().includes('rate') || e.message.toLowerCase().includes('quota'));
                     console.error(`Batch ${batchNum} attempt ${attempts} failed:`, e.message);
                     
                     if (isRateLimit && attempts < 3) {
                         await emit('progress', { message: `Rate limit hit on batch ${batchNum}. Waiting 35 seconds before retry (attempt ${attempts}/3)...` });
                         await new Promise(resolve => setTimeout(resolve, 35000));
                     } else if (attempts >= 3) {
                         // All retries exhausted - write originals as Error
                         console.error(`Batch ${batchNum} failed after 3 attempts. Writing error rows.`);
                         batch.forEach(b => {
                             allMergedResults.push({ id: b.id, status: 'Error', restored_text: b.q_text });
                         });
                         batchSuccess = true; // Exit while loop
                     } else {
                         // Non-rate-limit error, no point retrying
                         batch.forEach(b => {
                             allMergedResults.push({ id: b.id, status: 'Error', restored_text: b.q_text });
                         });
                         batchSuccess = true;
                     }
                 }
             }
             
             // 7-second delay between batches = ~8.5 RPM, safely under Gemini's 15 RPM free tier limit
             if (i + batchSize < flattenGroups.length) {
                 await new Promise(resolve => setTimeout(resolve, 7000));
             }
        }

        // 3. Map back to Excel Rows
        // We map exactly by the unique integer ID we generated
        const mergeMap = {};
        allMergedResults.forEach(r => {
            // Hardcoded Failsafe: If AI tagged it Incomplete but didn't actually change anything, force Complete
            const originalItem = flattenGroups.find(f => f.id === r.id);
            if (originalItem && r.status === 'Incomplete') {
                const origLower = String(originalItem.q_text || '').trim().toLowerCase();
                const newLower = String(r.restored_text || '').trim().toLowerCase();
                if (origLower === newLower) {
                    r.status = 'Complete';
                }
            }

            mergeMap[r.id] = {
                status: r.status,
                restored_text: r.restored_text
            };
        });

        // 4. Generate New Excel Workbook
        const worksheetData = [];
        
        // Add Headers: Original + 2 New Columns
        const newHeaders = [...parsedData.headers, 'Completion Status (AI)', 'Restored Question (AI)'];
        worksheetData.push(newHeaders);

        // Add Rows
        parsedData.orderedRoots.forEach(r => {
            parsedData.groups[r].forEach(item => {
                const aiData = mergeMap[item._id] || { status: 'Complete', restored_text: item.q_text };
                
                const newRow = [...item.full_data, aiData.status, aiData.restored_text];
                worksheetData.push(newRow);
            });
        });

        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
        XLSX.utils.book_append_sheet(workbook, worksheet, 'AI Restored Questions');

        // 5. Store File Temp in D1
        const outBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        const b64Excel = Buffer.from(outBuffer).toString('base64');
        const fileId = crypto.randomUUID();
        
        await c.env.DB.prepare(
            'INSERT INTO generated_files (id, data_base64) VALUES (?, ?)'
        ).bind(fileId, b64Excel).run();

        // Log Usage
        await logUsage(c.env, c, 'excel_merger', {
             input: totalInputTokens,
             output: totalOutputTokens,
             total: totalInputTokens + totalOutputTokens
        }, 1);

        // Build final preview rows retaining original text for UI rendering
        const previewRows = allMergedResults.slice(0, 10).map(r => {
            const originalItem = flattenGroups.find(f => f.id === r.id);
            return {
                original_num: originalItem ? String(originalItem.q_num).trim() : 'N/A',
                original_text: originalItem ? String(originalItem.q_text).trim() : '',
                status: r.status,
                restored_text: r.restored_text
            };
        });

        await emit('success', {
            status: "success",
            preview: previewRows,
            download_id: fileId,
            stats: {
                total_rows: parsedData.totalParsed,
                merged_rows: allMergedResults.filter(m => m.status === 'Incomplete').length
            },
            usage: {
                input_tokens: totalInputTokens,
                output_tokens: totalOutputTokens,
                total_tokens: totalInputTokens + totalOutputTokens
            }
        });

            } catch (streamErr) {
                console.error("Streaming AI merge failed:", streamErr);
                await emit('error', { message: streamErr.message });
            }
        });

    } catch (error) {
        console.error('Merge endpoint setup error:', error);
        return c.json({ error: 'Server Error during merge', details: error.message }, 500);
    }
});

// Download Merged Endpoint
app.get('/api/download-merged-excel/:id', async (c) => {
    try {
        const id = c.req.param('id');
        const doc = await c.env.DB.prepare('SELECT data_base64 FROM generated_files WHERE id = ?').bind(id).first();
        
        if (!doc) return c.text('File not found or expired', 404);
        
        const buffer = Buffer.from(doc.data_base64, 'base64');
        return new Response(buffer, {
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': 'attachment; filename=AI_Merged_Questions.xlsx',
            },
        });
    } catch (error) {
         return c.text('Error downloading file', 500);
    }
});

// ─── NEW Frontend-Chunked Architecture (3 micro-endpoints) ───────────────────

// 1. Parse Excel → returns flat list of question groups as JSON (fast, <5s)
app.post('/api/parse-excel', async (c) => {
    try {
        const body = await c.req.parseBody();
        const excelFile = body.file;
        if (!excelFile || !(excelFile instanceof File)) {
            return c.json({ error: 'No Excel file uploaded' }, 400);
        }
        const arrayBuffer = await excelFile.arrayBuffer();
        const parsedData = await processExcelMerge(arrayBuffer);

        let globalIndex = 0;
        const flattenGroups = [];
        parsedData.orderedRoots.forEach(r => {
            parsedData.groups[r].forEach(item => {
                globalIndex++;
                flattenGroups.push({ id: globalIndex, group_id: r, q_num: item.q_num, q_text: item.q_text });
                item._id = globalIndex;
            });
        });

        return c.json({
            flattenGroups,
            headers: parsedData.headers,
            rows: parsedData.orderedRoots.flatMap(r =>
                parsedData.groups[r].map(item => ({ _id: item._id, full_data: item.full_data }))
            ),
            totalParsed: parsedData.totalParsed
        });
    } catch (e) {
        console.error('parse-excel error:', e);
        return c.json({ error: e.message }, 500);
    }
});

// 2. Restore a single batch of pre-parsed rows through AI → returns JSON results (fast, <30s)
const DEFAULT_RESTORE_PROMPT = `You are a strict clinical AI medical editor.
You will receive a JSON array of sub-questions. Each object has an 'id', 'group_id', 'q_num', and 'q_text'.
Objects with the SAME 'group_id' belong to the same parent question and appear in sequential sub-part order.

CRITICAL INSTRUCTIONS:

0. ABSOLUTE RULE — 'a' SUBPARTS ARE ALWAYS COMPLETE AND NEVER MODIFIED:
   Any sub-question whose 'q_num' ends with the letter 'a' (e.g. "1.a", "5a", "10.a") is the PRIMARY lead question.
   You MUST always set status to 'Complete' and return the EXACT ORIGINAL 'q_text' unchanged. Do not alter punctuation, spacing, or a single character.
   This rule overrides ALL other rules below.

1. For sub-questions 'b', 'c', 'd', etc. — evaluate each 'q_text' to decide if it is 'Complete' or 'Incomplete'.

2. COMPLETE (non-'a' subparts): Any question that already contains the name of the specific disease, drug, or clinical condition. You can read it and immediately know the exact medical noun.
   Examples: "Clinical presentation of senile osteoporosis.", "Management of Hemangioma."
   If COMPLETE → set status 'Complete', return the EXACT ORIGINAL 'q_text' as 'restored_text'. Do NOT change a single character.

3. INCOMPLETE (non-'a' subparts): ONLY if the question uses a vague pronoun ("it", "they", "this", "that") OR completely lacks the core disease noun (e.g. "Clinical features and diagnostic criteria.", "Management of it.").

4. REWRITING INCOMPLETE QUESTIONS: Find the SAME question number's 'a' subpart (same 'group_id', q_num ending in 'a'). Extract the missing disease/noun from that 'a' subpart. Rewrite the incomplete question to include it.
   Example: group_id="Q1", 1a="Classify osteoporosis", 1b="Clinical features." → restored_text for 1b = "Clinical features of osteoporosis.", status = 'Incomplete'.

5. Output EVERY single 'id' provided. Do not drop any.
Return ONLY a valid JSON array with EXACTLY these keys: {"id": <int>, "status": "<Complete or Incomplete>", "restored_text": "<val>"}`;


app.post('/api/restore-batch', async (c) => {
    try {
        const { batch, systemPrompt } = await c.req.json();
        if (!Array.isArray(batch) || batch.length === 0) {
            return c.json({ error: 'Invalid batch' }, 400);
        }
        const prompt = systemPrompt || DEFAULT_RESTORE_PROMPT;
        const messages = [{ role: 'user', content: JSON.stringify(batch) }];
        const aiRes = await chatWithGemini(messages, [], prompt, c.env);
        let result = JSON.parse(aiRes.reply.replace(/```json|```/g, '').trim());
        if (!Array.isArray(result)) result = [result];

        // Hardcoded failsafe: if AI returned same text, force Complete
        result = result.map(r => {
            const orig = batch.find(b => b.id === r.id);
            if (orig && r.status === 'Incomplete') {
                if (String(orig.q_text).trim().toLowerCase() === String(r.restored_text).trim().toLowerCase()) {
                    r.status = 'Complete';
                }
            }
            return r;
        });

        return c.json({
            results: result,
            usage: {
                input: aiRes.usage?.promptTokenCount || 0,
                output: aiRes.usage?.candidatesTokenCount || 0
            }
        });
    } catch (e) {
        console.error('restore-batch error:', e);
        return c.json({ error: e.message }, 500);
    }
});

// 3. Build final Excel from all accumulated results → stores in D1 and returns download_id
app.post('/api/build-excel', async (c) => {
    try {
        const { allResults, flattenGroups, headers, rows } = await c.req.json();

        const mergeMap = {};
        allResults.forEach(r => { mergeMap[r.id] = { status: r.status, restored_text: r.restored_text }; });

        const rowMap = {};
        rows.forEach(r => { rowMap[r._id] = r.full_data; });

        const worksheetData = [];
        const newHeaders = [...headers, 'Completion Status (AI)', 'Restored Question (AI)', 'Modification Check'];
        worksheetData.push(newHeaders);

        flattenGroups.forEach(item => {
            const aiData = mergeMap[item.id] || { status: 'Complete', restored_text: item.q_text };
            const fullRow = rowMap[item.id] || [];

            // Modification Check: compare original vs AI output
            const originalNorm = String(item.q_text || '').trim();
            const restoredNorm = String(aiData.restored_text || '').trim();
            let modCheck;
            if (aiData.status === 'Complete') {
                modCheck = originalNorm === restoredNorm ? '✅ Retained' : '⚠️ Modified (AI changed a Complete question)';
            } else {
                modCheck = originalNorm !== restoredNorm ? '✅ Restored' : '⚠️ Not Restored (AI marked Incomplete but kept same text)';
            }

            worksheetData.push([...fullRow, aiData.status, aiData.restored_text, modCheck]);
        });

        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
        XLSX.utils.book_append_sheet(workbook, worksheet, 'AI Restored Questions');

        const outBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        const b64Excel = Buffer.from(outBuffer).toString('base64');
        const fileId = crypto.randomUUID();

        await c.env.DB.prepare('INSERT INTO generated_files (id, data_base64) VALUES (?, ?)').bind(fileId, b64Excel).run();

        const incomplete_count = allResults.filter(r => r.status === 'Incomplete').length;
        const modified_count = worksheetData.slice(1).filter(r => r[r.length - 1]?.startsWith('⚠️')).length;
        return c.json({ download_id: fileId, incomplete_count, total: flattenGroups.length, modified_count });
    } catch (e) {
        console.error('build-excel error:', e);
        return c.json({ error: e.message }, 500);
    }
});
// ─────────────────────────────────────────────────────────────────────────────


// Prompt Library (D1)
app.get('/api/prompts', async (c) => {
    try {
        const { results } = await c.env.DB.prepare('SELECT * FROM prompts ORDER BY created_at DESC').all();
        return c.json(results || []);
    } catch (error) {
        console.error('Fetch prompts error:', error);
        return c.json({ error: error.message }, 500);
    }
});

app.post('/api/prompts', async (c) => {
    try {
        const { name, university, state, type, content } = await c.req.json();
        const result = await c.env.DB.prepare(
            'INSERT INTO prompts (name, university, state, type, content) VALUES (?, ?, ?, ?, ?) RETURNING *'
        )
            .bind(name, university, state, type, content)
            .first();
        return c.json(result);
    } catch (error) {
        console.error('Create prompt error:', error);
        return c.json({ error: error.message }, 500);
    }
});

app.put('/api/prompts/:id', async (c) => {
    try {
        const id = c.req.param('id');
        const { name, university, state, type, content } = await c.req.json();
        const result = await c.env.DB.prepare(
            'UPDATE prompts SET name = ?, university = ?, state = ?, type = ?, content = ? WHERE id = ? RETURNING *'
        )
            .bind(name, university, state, type, content, id)
            .first();
        return c.json(result);
    } catch (error) {
        console.error('Update prompt error:', error);
        return c.json({ error: error.message }, 500);
    }
});

app.delete('/api/prompts/:id', async (c) => {
    try {
        const id = c.req.param('id');
        await c.env.DB.prepare('DELETE FROM prompts WHERE id = ?').bind(id).run();
        return c.json({ success: true });
    } catch (error) {
        console.error('Delete prompt error:', error);
        return c.json({ error: error.message }, 500);
    }
});

// AI Chat Assistant
app.post('/api/chat', async (c) => {
    try {
        const { messages, attachments, promptContext } = await c.req.json();

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return c.json({ error: 'Messages array is required' }, 400);
        }

        // Validate attachments (optional)
        const validAttachments = (attachments || []).filter(att => att.mimeType && att.base64);

        const result = await chatWithGemini(messages, validAttachments, promptContext || '', c.env);

        // Log usage for analytics
        await logUsage(c.env, c, 'chat', {
            input: result.usage.input_tokens,
            output: result.usage.output_tokens,
            total: result.usage.total_tokens
        });

        return c.json(result);
    } catch (error) {
        console.error('Chat error:', error);
        return c.json({ error: error.message }, 500);
    }
});

// Chat Prompts Library (D1)
app.get('/api/chat-prompts', async (c) => {
    try {
        const { results } = await c.env.DB.prepare('SELECT * FROM chat_prompts ORDER BY created_at DESC').all();
        return c.json(results || []);
    } catch (error) {
        console.error('Fetch chat prompts error:', error);
        return c.json({ error: error.message, stack: error.stack }, 500);
    }
});

app.post('/api/chat-prompts', async (c) => {
    try {
        const { name, type, content } = await c.req.json();
        const result = await c.env.DB.prepare(
            'INSERT INTO chat_prompts (name, type, content) VALUES (?, ?, ?) RETURNING *'
        )
            .bind(name, type, content)
            .first();
        return c.json(result);
    } catch (error) {
        console.error('Create chat prompt error:', error);
        return c.json({ error: error.message, stack: error.stack }, 500);
    }
});

app.put('/api/chat-prompts/:id', async (c) => {
    try {
        const id = c.req.param('id');
        const { name, type, content } = await c.req.json();
        const result = await c.env.DB.prepare(
            'UPDATE chat_prompts SET name = ?, type = ?, content = ? WHERE id = ? RETURNING *'
        )
            .bind(name, type, content, id)
            .first();
        return c.json(result);
    } catch (error) {
        console.error('Update chat prompt error:', error);
        return c.json({ error: error.message }, 500);
    }
});

app.delete('/api/chat-prompts/:id', async (c) => {
    try {
        const id = c.req.param('id');
        await c.env.DB.prepare('DELETE FROM chat_prompts WHERE id = ?').bind(id).run();
        return c.json({ success: true });
    } catch (error) {
        console.error('Delete chat prompt error:', error);
        return c.json({ error: error.message }, 500);
    }
});

// ══ AI Repeat Sorter Endpoint ══════════════════════════════════════════════
// Accepts ONE batch of groups per call (frontend handles iteration + progress)
app.post('/api/ai-sorter', async (c) => {
    try {
        const { groups, logUsageOnLastBatch, totalGroupsForLog } = await c.req.json();
        if (!Array.isArray(groups) || groups.length === 0) {
            return c.json({ error: 'groups array is required' }, 400);
        }

        const SORTER_PROMPT = `You are a precise medical question merger AI.
You will receive a JSON array of duplicate question groups. Each group has:
- "groupId": the group identifier (e.g. "G1")
- "repQuestion": the representative question text
- "similarQuestions": array of similar question texts
- "indices": position indices (0 = rep, 1+ = similar)

Your task for each group:
1. Read the repQuestion and all similarQuestions carefully.
2. Determine which questions share the SAME core medical topic/disease.
3. For questions sharing the same core topic: MERGE into one comprehensive question covering ALL their sub-asks. Combine naturally, do not repeat sub-topics.
4. Questions NOT sharing the core topic: separate unmerged entries.
5. All same topic → one merged result. Partial match → subgroups (A = merged, B/C = outliers).

Return ONLY a valid JSON array. Each element:
{
  "groupId": "G1",
  "subGroup": "A",
  "status": "Merged",
  "mergedQuestion": "...",
  "mergedIndices": [0, 1, 2]
}`;

        const messages = [{ role: 'user', content: JSON.stringify(groups) }];
        let results = [];
        let inputTokens = 0;
        let outputTokens = 0;

        // Single AI call for this batch (retry once on rate-limit)
        let attempts = 0;
        while (attempts < 2) {
            attempts++;
            try {
                const aiRes = await chatWithGemini(messages, [], SORTER_PROMPT, c.env);
                let parsed = JSON.parse(aiRes.reply.replace(/```json|```/g, '').trim());
                if (!Array.isArray(parsed)) parsed = [parsed];
                results = parsed;
                inputTokens = aiRes.usage?.promptTokenCount || 0;
                outputTokens = aiRes.usage?.candidatesTokenCount || 0;
                break;
            } catch (e) {
                const isRateLimit = e.message && (e.message.includes('429') || e.message.toLowerCase().includes('rate'));
                if (isRateLimit && attempts < 2) {
                    await new Promise(r => setTimeout(r, 30000));
                } else {
                    // Fallback: return groups as unmerged
                    results = groups.map(g => ({
                        groupId: g.groupId, subGroup: null,
                        status: 'Error', mergedQuestion: g.repQuestion, mergedIndices: [0]
                    }));
                    break;
                }
            }
        }

        // Log to D1 only when frontend signals this is the last batch
        if (logUsageOnLastBatch) {
            await logUsage(c.env, c, 'ai_repeat_sorter', {
                input: inputTokens, output: outputTokens,
                total: inputTokens + outputTokens
            }, totalGroupsForLog || groups.length);
        }

        return c.json({
            results,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
        });
    } catch (error) {
        console.error('AI Sorter error:', error);
        return c.json({ error: error.message }, 500);
    }
});

// Admin Analytics Endpoint (upgraded with per-feature breakdown + cost)
app.get('/api/admin/analytics', async (c) => {
    try {
        const reqUserEmail = c.req.query('userEmail');
        const userFilterClause = reqUserEmail ? "AND user_email = ?" : "";
        const userParams = reqUserEmail ? [reqUserEmail] : [];

        // All unique users
        const allUsers = await c.env.DB.prepare(
            'SELECT DISTINCT user_email FROM usage_logs ORDER BY user_email ASC'
        ).all();

        // Per-user per-feature breakdown (all time)
        const perUserFeature = await c.env.DB.prepare(`
            SELECT
                user_email,
                event_type,
                COUNT(*) as operations,
                SUM(token_input) as total_input,
                SUM(token_output) as total_output,
                SUM(token_total) as total_tokens,
                MAX(DATETIME(created_at, '+5 hours', '+30 minutes')) as last_used
            FROM usage_logs
            WHERE 1=1 ${userFilterClause}
            GROUP BY user_email, event_type
            ORDER BY user_email, total_tokens DESC
        `).bind(...userParams).all();

        // Daily totals (last 30 days, IST)
        const dailyTotals = await c.env.DB.prepare(`
            SELECT
                DATE(created_at, '+5 hours', '+30 minutes') as date,
                SUM(token_total) as total_tokens,
                SUM(token_input) as total_input,
                SUM(token_output) as total_output,
                COUNT(CASE WHEN event_type = 'extraction' THEN 1 END) as extractions,
                COUNT(CASE WHEN event_type = 'excel_merger' THEN 1 END) as context_restorations,
                COUNT(CASE WHEN event_type = 'ai_repeat_sorter' THEN 1 END) as repeat_sorts,
                COUNT(CASE WHEN event_type = 'chat' THEN 1 END) as chats,
                COUNT(DISTINCT user_email) as active_users
            FROM usage_logs
            WHERE 1=1 ${userFilterClause}
            GROUP BY DATE(created_at, '+5 hours', '+30 minutes')
            ORDER BY DATE(created_at, '+5 hours', '+30 minutes') DESC
            LIMIT 30
        `).bind(...userParams).all();

        // Today's user breakdown (IST)
        const userBreakdown = await c.env.DB.prepare(`
            SELECT
                user_email,
                SUM(token_total) as total_tokens,
                SUM(token_input) as total_input,
                SUM(token_output) as total_output,
                COUNT(*) as events,
                MAX(DATETIME(created_at, '+5 hours', '+30 minutes')) as last_active
            FROM usage_logs
            WHERE DATE(created_at, '+5 hours', '+30 minutes') = DATE('now', '+5 hours', '+30 minutes')
            ${userFilterClause}
            GROUP BY user_email
            ORDER BY total_tokens DESC
        `).bind(...userParams).all();

        // Recent activity
        const recentActivity = await c.env.DB.prepare(`
            SELECT
                id,
                user_email,
                event_type,
                token_input,
                token_output,
                token_total,
                file_count,
                DATETIME(created_at, '+5 hours', '+30 minutes') as created_at
            FROM usage_logs
            WHERE 1=1 ${userFilterClause}
            ORDER BY id DESC
            LIMIT 30
        `).bind(...userParams).all();

        // All-time totals per feature (for summary cards)
        const featureTotals = await c.env.DB.prepare(`
            SELECT
                event_type,
                COUNT(*) as operations,
                SUM(token_input) as total_input,
                SUM(token_output) as total_output,
                SUM(token_total) as total_tokens
            FROM usage_logs
            WHERE 1=1 ${userFilterClause}
            GROUP BY event_type
        `).bind(...userParams).all();

        return c.json({
            allUsers: allUsers.results ? allUsers.results.map(r => r.user_email) : [],
            perUserFeature: perUserFeature.results || [],
            dailyTotals: dailyTotals.results || [],
            userBreakdown: userBreakdown.results || [],
            recentActivity: recentActivity.results || [],
            featureTotals: featureTotals.results || []
        });
    } catch (error) {
        console.error('Analytics error:', error);
        return c.json({ error: error.message }, 500);
    }
});

export default app;
