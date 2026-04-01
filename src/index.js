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
        const model = body.model || 'gemini-2.5-flash-lite';

        if (!pdfFile || !(pdfFile instanceof File)) {
            return c.json({ error: 'No file uploaded' }, 400);
        }

        const arrayBuffer = await pdfFile.arrayBuffer();
        const pdfBase64 = Buffer.from(arrayBuffer).toString('base64');

        const { data, usage } = await extractFromPdf(pdfBase64, customPrompt, temperature, c.env, model);

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
        // Capture user email HERE before entering SSE stream (c.req not accessible inside stream callback)
        const userEmail = c.req.header('X-User-Email') || c.req.header('Cf-Access-Authenticated-User-Email') || 'anonymous@internal.com';
        
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
                const defaultPrompt = `You are a strict clinical AI medical editor functioning as a VALIDATOR, not an appender.
You will receive a JSON array of sub-questions. Each object has an 'id', 'group_id', 'q_num', and 'q_text'.
Objects with the strict SAME 'group_id' belong to the same parent question.
CRITICAL INSTRUCTIONS:
1. THE ANCHOR IMMUNITY RULE:
   Any question whose 'q_num' contains 'A' or 'a' (e.g., "1.a", "5A") OR is a standalone consecutive number with NO subpart letters (e.g., "6.", "7") is an ANCHOR. 
   Anchors ONLY provide context; they NEVER receive context. 
   For ALL Anchors: You MUST set status to 'Complete' and return the EXACT ORIGINAL 'q_text' unmodified. Zero exceptions.
2. THE STANDALONE CONCEPT RULE ("Do No Harm"):
   Scan 'b', 'c', or 'd' subparts for a primary medical entity.
   If the sub-question already contains its own distinct medical disease, condition, anatomical structure, or specific procedure (e.g., "Mycetoma", "Adaptive immunity", "Meta-analysis", "Child sexual abuse"), do NOT touch it! 
   If it already stands on its own medically, set status to 'Complete' and return the EXACT ORIGINAL 'q_text'. Do not fuse distinct concepts together.
3. THE TRUE DEPENDENCY RULE (When to intervene):
   You are ONLY allowed to mark a sub-question as 'Incomplete' and modify it if it is blatantly medically orphaned:
   - It contains vague pronouns ("Their role in thermoregulation", "Management of it").
   - It is a naked phrase missing a subject ("Complications.", "Clinical features.", "Investigations.").
   ONLY in these valid orphan cases may you look at the Anchor ('a' subpart) of the same 'group_id' to extract the missing noun and append it.
4. THE CLINICAL SCENARIO PROTECTION RULE:
   If a question contains a clinical vignette/scenario (e.g., "A 20-year-old female presents with..."), you are FORBIDDEN from deleting, summarizing, or shortening the original text. You may only APPEND missing words.
5. ANTI-HALLUCINATION PROTOCOL:
   NEVER use brackets, placeholders (e.g. "[disease]"), or meta-commentary. If you cannot confidently determine the missing noun, fail gracefully by setting status to 'Complete' and returning the exact original text.
6. Output EVERY single 'id' provided. Do not drop any items.
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

        // Log Usage — use direct DB insert since c.req is unavailable inside SSE stream
        try {
            await c.env.DB.prepare(
                'INSERT INTO usage_logs (user_email, event_type, token_input, token_output, token_total, file_count) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(userEmail, 'excel_merger', totalInputTokens, totalOutputTokens, totalInputTokens + totalOutputTokens, 1).run();
        } catch (logErr) {
            console.error('Usage log error (excel_merger):', logErr);
        }

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
const DEFAULT_RESTORE_PROMPT = `You are a strict clinical AI medical editor functioning as a VALIDATOR, not an appender.
You will receive a JSON array of sub-questions. Each object has an 'id', 'group_id', 'q_num', and 'q_text'.
Objects with the SAME 'group_id' belong to the same parent question.

CRITICAL INSTRUCTIONS:

1. THE ANCHOR IMMUNITY RULE:
   Any question whose 'q_num' contains 'A' or 'a' (e.g., "1.a", "5A") OR is a standalone consecutive number with NO subpart letters (e.g., "6.", "7") is an ANCHOR. 
   Anchors ONLY provide context; they NEVER receive context. 
   For ALL Anchors: You MUST set status to 'Complete' and return the EXACT ORIGINAL 'q_text' unmodified. Zero exceptions.

2. THE STANDALONE CONCEPT RULE (The "Medical Noun" Rule):
   Before attempting to restore, check if the question already contains its own distinct medical disease, condition, anatomical structure, or specific procedure.
   - If a question is medically complete (e.g., "Excessive day sleepiness", "Mycetoma", "Adaptive immunity", "Indications for Polysomnography", "Evaluation of small airways"), do NOT touch it! 
   - If it stands on its own, set status to 'Complete' and return the EXACT ORIGINAL 'q_text'.
   - NEVER "synthesize" or link two different topics (e.g., do NOT add "in children" to "Evaluation of small airways" just because the anchor mentioned children). 
   - Each sub-question ('b', 'c', etc.) should be treated as a separate standalone exam question if it contains a medical noun.

3. THE SEAMLESS CLINICAL INTEGRATION RULE (When to intervene):
   You are ONLY allowed to mark a sub-question as 'Incomplete' and modify it if it is blatantly medically orphaned:
   - It contains vague pronouns or relative indicators ("it", "they", "this", "that", "above", "such", "these", "those").
   - It is a naked phrase missing a subject ("Complications.", "Clinical features.", "Investigations.", "Describe its management.").
   
   INTELLIGENT REWRITING: Do NOT blindly append the noun. Instead, SWAP the vague phrase with the actual medical subject from the Anchor ('a' subpart) of the same 'group_id'.
   - Bad: "How would you manage such a patient with Falciparum Malaria?" (Double mention)
   - Good: "How would you manage a patient with respiratory and non-respiratory complications of Falciparum Malaria?"
   - Bad: "Management of such a case in ICU of Community Acquired Pneumonia" (Clunky)
   - Good: "Management of Community Acquired Pneumonia in ICU."

4. THE CLINICAL SCENARIO PROTECTION RULE:
   If a question contains a clinical vignette/scenario (e.g., "A 20-year-old female presents with..."), you are FORBIDDEN from deleting, summarizing, or shortening the original text. You may only integrate missing context if the lead-in question at the end is vague.

5. ANTI-HALLUCINATION PROTOCOL:
   NEVER use brackets, placeholders (e.g. "[disease]"), or meta-commentary. The final 'restored_text' must read like a professionally framed medical board exam question. If you cannot confidently determine the subject, return the original text.

6. Output EVERY single 'id' provided. Do not drop any items.
Return ONLY a valid JSON array containing EXACTLY these keys: {"id": <int>, "status": "<Complete or Incomplete>", "restored_text": "<val>"}`;


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

        // Removed same-text failsafe to allow HITL manual review of subtle drafts

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
        const { allResults, flattenGroups, headers, rows, usage } = await c.req.json();

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

        if (usage && (usage.input > 0 || usage.output > 0)) {
            await logUsage(c.env, c, 'excel_merger', {
                input: usage.input,
                output: usage.output,
                total: usage.input + usage.output
            }, 1);
        }

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

app.get('/api/sorter-prompt', (c) => {
    return c.json({ prompt: SORTER_PROMPT });
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

app.get('/api/manual-sorter-prompt', async (c) => {
    try {
        const result = await c.env.DB.prepare("SELECT content FROM prompts WHERE type = 'manual_sorter' ORDER BY created_at DESC LIMIT 1").first();
        return c.json({ prompt: result?.content || MANUAL_MERGE_PROMPT });
    } catch (error) {
        console.error('Fetch manual prompt error:', error);
        return c.json({ prompt: MANUAL_MERGE_PROMPT });
    }
});

app.post('/api/manual-sorter-prompt', async (c) => {
    try {
        const { content } = await c.req.json();
        const existing = await c.env.DB.prepare("SELECT id FROM prompts WHERE type = 'manual_sorter' ORDER BY created_at DESC LIMIT 1").first();
        
        if (existing) {
            await c.env.DB.prepare("UPDATE prompts SET content = ? WHERE id = ?").bind(content, existing.id).run();
        } else {
            await c.env.DB.prepare("INSERT INTO prompts (name, type, content) VALUES (?, ?, ?)").bind("Manual Sorter Prompt", "manual_sorter", content).run();
        }
        return c.json({ success: true });
    } catch (error) {
        console.error('Update manual prompt error:', error);
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

// HITL Settings (Context Restorer)
app.get('/api/hitl-settings', async (c) => {
    try {
        const { results } = await c.env.DB.prepare('SELECT * FROM hitl_settings').all();
        return c.json(results || []);
    } catch (error) {
        console.error('Fetch hitl settings error:', error);
        return c.json({ error: error.message }, 500);
    }
});

app.post('/api/hitl-settings', async (c) => {
    try {
        const { type, content } = await c.req.json();
        await c.env.DB.prepare('INSERT INTO hitl_settings (type, content) VALUES (?, ?) ON CONFLICT(type) DO UPDATE SET content = EXCLUDED.content, updated_at = CURRENT_TIMESTAMP')
            .bind(type, content)
            .run();
        return c.json({ success: true });
    } catch (error) {
        console.error('Update hitl settings error:', error);
        return c.json({ error: error.message }, 500);
    }
});

// AI Chat Assistant
app.post('/api/chat', async (c) => {
    try {
        const { messages, attachments, promptContext, model } = await c.req.json();

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return c.json({ error: 'Messages array is required' }, 400);
        }

        // Validate attachments (optional)
        const validAttachments = (attachments || []).filter(att => att.mimeType && att.base64);

        const result = await chatWithGemini(messages, validAttachments, promptContext || '', c.env, model);

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

// ══ AI Repeat Sorter — System Prompt (module scope for dynamic API access) ══
const SORTER_PROMPT = `You are a precise medical exam question merger AI working on Indian medical university exam question banks.

You receive a JSON array. Each element has:
- "groupId": group ID (e.g. "G1")
- "repQuestion": the representative question text (index 0)
- "similarQuestions": array of similar question texts (indices 1, 2, 3, ...)
- "totalQuestions": total count = 1 (rep) + similarQuestions.length — you MUST account for ALL of these in your output

═══════════════════════════════════════════════════════════
PRINCIPLE 1: THE LEDGER OF CONSERVATION (Zero Loss, Zero Duplication)
═══════════════════════════════════════════════════════════
There are exactly 'totalQuestions' in this group, indexed from 0 to (totalQuestions - 1). 
EVERY SINGLE INDEX must appear in your output EXACTLY ONCE. 
- You cannot drop an index (that deletes a question).
- You cannot put an index in two different output rows (that hallucinates a duplicate).
Validate your work logically: Do the 'mergedIndices' arrays across all your output objects collectively contain every integer from 0 to N-1 exactly once?

═══════════════════════════════════════════════════════════
PRINCIPLE 2: THE "SUBJECT VS ACTION" RULE (Universal Entity Isolation)
═══════════════════════════════════════════════════════════
STEP 1: Identify the CORE SUBJECT (the Primary Noun/Entity) of each question.
STEP 2: Map every single index (0 to N-1) to exactly ONE entity bucket.

- RULE A: ACTIONS ARE NOT SUBJECTS. Words like "Anatomy," "Management," "Classification," "Histology," "Complications," "Indications," "Types of," "Discuss," or "Describe" are ACTIONS. NEVER merge questions just because they share the same action word. The Subject is the specific bone, drug, disease, test, or procedure being studied.
- RULE B: SUBJECT DISPARITY IS A HARD STOP. If the primary subjects are different, you MUST NOT merge them, even if the action word is identical.
    * Disease examples (MANDATORY SEPARATION): "Management of COPD" ≠ "Management of Shock" ≠ "Management of Asthma"
    * Anatomy examples: "Anatomy of Femur" ≠ "Anatomy of Tibia"
    * Drug examples: "Adverse effects of Rifampicin" ≠ "Adverse effects of Bedaquiline"
    * Test examples: "Bronchoprovocation test" ≠ "Chi-square test" ≠ "PET scan" ≠ "Spirometry"
- RULE C: CLINICALLY RELATED BUT DISTINCT ENTITIES MUST NOT BE MERGED. (e.g. "Vitiligo" ≠ "Melasma", "COPD" ≠ "Pulmonary Fibrosis")
- RULE D: MANDATORY IDENTICAL MERGES. If two or more questions have 100% identical text (ignoring minor casing, punctuation, or leading bullets), they MUST be merged into a single bucket. This is mandatory even if they come from different years or sources.

═══════════════════════════════════════════════════════════
PRINCIPLE 3: SPECIFIC CLINICAL HARD STOP BOUNDARIES
═══════════════════════════════════════════════════════════
NEVER merge across these boundaries. Each represents a unique, standalone exam topic:

1. INVESTIGATION/TEST DISPARITY: Each named test is its own entity — whether it is a statistical test (Chi-square, Student's t-test, ANOVA), a clinical test (Bronchoprovocation, Mantoux), a lung function test (Spirometry, Peak Flow), or an imaging test (PET scan, CT, MRI, Bronchoscopy). NEVER group different tests together.
2. DRUG ISOLATION: Each named drug or pharmacological agent is a separate entity. Do NOT merge different drugs into a "Thematic Superset" like "TB Drugs" or "COPD Inhalers." If you have 5 different drugs, you MUST produce 5 separate rows.
3. TOPIC/DISEASE DISPARITY: Different named diseases, conditions, syndromes, or procedures are separate entities. Sharing a classification or management action word is NOT a reason to merge.
4. AGE DISPARITY: Adult vs. Pediatric / Neonatal vs. Elderly. (e.g., "Adult PKLD" ≠ "Infantile PKLD")
5. SEX DISPARITY: Male vs. Female. (e.g., "Male Genital Discharge" ≠ "Female Vaginal Discharge")
6. CHRONICITY: Acute vs. Chronic. (e.g., "Acute Pneumonia" ≠ "Chronic Pneumonia")

═══════════════════════════════════════════════════════════
PRINCIPLE 4: SUPERSET SYNTHESIS & THE MINIMALIST EXCEPTION
═══════════════════════════════════════════════════════════
For buckets containing 2 or more indices (MERGING IS OCCURRING):
- ANTI-THEMATIC WARNING: Do NOT create "Thematic Supersets." If you have questions about 5 different drugs, keep 5 rows. Do NOT consolidate.
- THE MINIMALIST EXCEPTION: If all items belonging to a bucket are 100% identical (e.g., "Home Sleep Testing" + "home sleep testing"), you MUST return the original text as-is. You are FORBIDDEN from adding "Discuss the...", "Outline the...", or any professional synthesis for identical merges.
- STRICT SYNTHESIS: Only use professional synthesis (e.g., "Discuss the clinical features and treatment of...") if you are merging different sub-aspects of the EXACT SAME medical entity.
- THE GENERAL + SPECIFIC RULE: If your bucket contains a broad, isolated question about the entity itself (e.g., "Sezary syndrome") AND specific sub-aspect questions (e.g., "Treatment of Sezary syndrome"), your merged sentence MUST explicitly request a definition or general discussion of the entity before attaching the specific sub-aspects. 
  * Correct Output: "Write a detailed note on Sezary syndrome, including its clinical features and treatment." 
  * Incorrect Output: "Discuss the clinical features and treatment of Sezary syndrome." (This ignores the general isolated question).

For buckets containing only 1 index (NO MERGING OCCURRING):
- Clean minimally (remove leading "a)", "b)", "1.") but keep the core text identical. DO NOT add "Discuss the..." if it wasn't there originally.

═══════════════════════════════════════════════════════════
OUTPUT FORMAT REQUIREMENTS
═══════════════════════════════════════════════════════════
Return ONLY a valid JSON array. For each basket/entity you created:
{
  "groupId": "G1",           // Exact same as input
  "subGroup": null,          // Use "A", "B", "C" ONLY if the group is split into multiple rows. If all indices merged into one single output row, use null.
  "status": "Merged",        // MUST be "Unmerged" if mergedIndices contains only ONE number. MUST be "Merged" if it contains 2 or more.
  "mergedQuestion": "...",   // The newly synthesized Superset question, or the original cleaned text if Unmerged
  "mergedIndices": [0, 1]    // The exact array of indices placed in this bucket. (e.g. [0, 2, 4])
}
CRITICAL REMINDER 1: The 'mergedIndices' array is strictly LOCAL to each groupId! You MUST reset the counter to 0 for every single group. NEVER count continuously across multiple groups.
CRITICAL REMINDER 2: The sum length of all mergedIndices arrays across a subgroup MUST exactly equal 'totalQuestions' for that group.
CRITICAL REMINDER 3: If mergedIndices has length 1 (e.g. [0]), the status MUST be "Unmerged". You can ONLY use "Merged" for 2 or more indices.
CRITICAL REMINDER 4: subGroup must be null (not "A") when this group produces exactly ONE output row.`;

const MANUAL_MERGE_PROMPT = `You are an expert medical editor working on an Indian medical university exam question bank. 
You will receive a JSON array of medical exam questions that all relate to the exact same clinical entity. 
Your ONLY job is to synthesize these questions into ONE single, well-formulated, comprehensive medical exam question that covers all the aspects mentioned in the array.

RULES:
1. THE GENERAL + SPECIFIC RULE: If the list contains a broad, isolated question about the entity itself (e.g., "Sezary syndrome") AND specific sub-aspect questions (e.g., "Treatment of Sezary syndrome"), your merged sentence MUST explicitly request a definition or general note on the entity before attaching the specific sub-aspects. 
   - Correct Output: "Write a detailed note on Sezary syndrome, including its clinical features and treatment." 
2. STRICT SYNTHESIS: Only use professional synthesis (e.g., "Discuss the clinical features and treatment of...") to combine the sub-aspects smoothly.
3. NO META-COMMENTARY. Return ONLY the final synthesized question text as a plain string. Do NOT return JSON. Do NOT use markdown. Just the raw text.`;

// ══ AI Repeat Sorter Endpoint ══════════════════════════════════════════════
// Accepts ONE batch of groups per call (frontend handles iteration + progress)
app.post('/api/ai-sorter', async (c) => {
    try {
        const { groups, logUsageOnLastBatch, totalGroupsForLog } = await c.req.json();
        if (!Array.isArray(groups) || groups.length === 0) {
            return c.json({ error: 'groups array is required' }, 400);
        }

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

// ══ HITL Manual Sorter Merge Endpoint ══════════════════════════════════════
// Accepts an array of question strings to synthesize into one
app.post('/api/manual-sorter-merge', async (c) => {
    try {
        const { questions } = await c.req.json();
        if (!Array.isArray(questions) || questions.length === 0) {
            return c.json({ error: 'questions array is required' }, 400);
        }

        let activePrompt = MANUAL_MERGE_PROMPT;
        try {
            const dbPrompt = await c.env.DB.prepare("SELECT content FROM prompts WHERE type = 'manual_sorter' ORDER BY created_at DESC LIMIT 1").first();
            if (dbPrompt && dbPrompt.content) {
                activePrompt = dbPrompt.content;
            }
        } catch (e) { console.error("Could not fetch manual sorter prompt", e); }

        const messages = [{ role: 'user', content: JSON.stringify(questions) }];
        
        const aiRes = await chatWithGemini(messages, [], activePrompt, c.env);
        const resultText = aiRes.reply.replace(/```json|```/g, '').trim();

        // Send normal mapped schema to frontend
        return c.json({
            mergedQuestion: resultText,
            usage: {
                input_tokens: aiRes.usage.promptTokenCount || 0,
                output_tokens: aiRes.usage.candidatesTokenCount || 0,
                total_tokens: aiRes.usage.totalTokenCount || 0
            }
        });
    } catch (error) {
        console.error('Manual Sorter Merge error:', error);
        return c.json({ error: error.message }, 500);
    }
});

// Global Analytics Ingestion Endpoint (Aggregate Push)
app.post('/api/analytics', async (c) => {
    try {
        const body = await c.req.json();
        const { eventType, tokenInput, tokenOutput, tokenTotal, fileCount } = body;
        
        c.executionCtx.waitUntil(
            logUsage(c.env, c, eventType || 'hitl_manual_session', {
                input: tokenInput || 0,
                output: tokenOutput || 0,
                total: tokenTotal || ((tokenInput || 0) + (tokenOutput || 0))
            }, fileCount || 1)
        );
        
        return c.json({ success: true, message: 'Analytics recorded' });
    } catch (error) {
        console.error('Analytics aggregation error:', error);
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
