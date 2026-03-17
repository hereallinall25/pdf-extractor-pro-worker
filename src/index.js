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

        const workbook = await generateExcel(data);
        const buffer = await workbook.xlsx.writeBuffer();

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
                const systemPrompt = `You are a strict clinical AI medical editor. 
You will receive a JSON array of sub-questions. Each object has an 'id', 'group_id', 'q_num', and 'q_text'.
Objects with the strict SAME 'group_id' belong to the same parent question and appear in sequential order.
CRITICAL INSTRUCTIONS:
1. Evaluate each 'q_text' individually to decide if it is 'Complete' or 'Incomplete'.
2. What is COMPLETE: Any question or phrase that explicitly navmes the disease, bone, or condition it is asking about is COMPLETE. 
   Examples of COMPLETE: "Clinical presentation and management of senile osteoporosis.", "Morning stiffness.", "Fracture healing.", "Various factors influencing fracture healing."
   If it is COMPLETE, set status to 'Complete' and return the EXACT ORIGINAL 'q_text' as 'restored_text'. Do not change a single letter.
3. What is INCOMPLETE: A question is only INCOMPLETE if it uses a vague pronoun ("it", "they", "this") or completely lacks the disease noun, meaning you cannot understand what it is asking about without looking at the question above it. 
   Examples of INCOMPLETE: "How will you treat it?", "Management of it.", "Sub-classification.", "Clinical features."
4. REWRITING INCOMPLETE QUESTIONS: If you mark it 'Incomplete', you MUST look at the preceding question with the SAME 'group_id'. Find the disease/noun in that preceding question, and rewrite the incomplete question to include it.
   Example: If 1a="Classify osteoporosis" and 1b="Clinical features.", you must return 'restored_text' as "Clinical features of osteoporosis." and status as 'Incomplete'.
5. You MUST output EVERY single 'id' provided in the batch. Do not drop any items.
Return ONLY a valid JSON array containing EXACTLY these keys: {"id": <int>, "status": "<Complete or Incomplete>", "restored_text": "<val>"}`;

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
             await emit('progress', { message: `AI Merging Group ${Math.floor(i/batchSize)+1} of ${Math.ceil(flattenGroups.length/batchSize)}...` });
             const messages = [
                 { role: 'user', content: JSON.stringify(batch) }
             ];
             
             try {
                const aiRes = await chatWithGemini(messages, [], systemPrompt, c.env);
                let mergedResult = JSON.parse(aiRes.reply.replace(/```json|```/g, '').trim());
                if (!Array.isArray(mergedResult)) { mergedResult = [mergedResult]; }
                allMergedResults.push(...mergedResult);
                
                totalInputTokens += aiRes.usage?.promptTokenCount || 0;
                totalOutputTokens += aiRes.usage?.candidatesTokenCount || 0;
             } catch (e) {
                console.error("Failed to parse batch or API Error:", e);
                // Fallback: put originals in if parse or API fails
                batch.forEach(b => {
                    allMergedResults.push({ id: b.id, status: 'Error', restored_text: b.q_text });
                });
             }
        }

        // 3. Map back to Excel Rows
        // We map exactly by the unique integer ID we generated
        const mergeMap = {};
        allMergedResults.forEach(r => {
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

// Admin Analytics Endpoint
app.get('/api/admin/analytics', async (c) => {
    try {
        const reqUserEmail = c.req.query('userEmail');
        const userFilterClause = reqUserEmail ? "AND user_email = ?" : "";
        const userParams = reqUserEmail ? [reqUserEmail] : [];

        // Get All Unique Users for Dropdown
        const allUsers = await c.env.DB.prepare(`
            SELECT DISTINCT user_email FROM usage_logs ORDER BY user_email ASC
        `).all();

        // Get Daily Totals (IST Timezone)
        const dailyTotals = await c.env.DB.prepare(`
            SELECT 
                DATE(created_at, '+5 hours', '+30 minutes') as date,
                SUM(token_total) as total_tokens,
                COUNT(CASE WHEN event_type = 'extraction' THEN 1 END) as extractions,
                COUNT(CASE WHEN event_type = 'chat' THEN 1 END) as chats,
                COUNT(CASE WHEN event_type = 'excel_merger' THEN 1 END) as merges,
                COUNT(DISTINCT user_email) as active_users
            FROM usage_logs
            WHERE 1=1 ${userFilterClause}
            GROUP BY DATE(created_at, '+5 hours', '+30 minutes')
            ORDER BY DATE(created_at, '+5 hours', '+30 minutes') DESC
            LIMIT 30
        `).bind(...userParams).all();

        // Get User Breakdown (Today in IST)
        const userBreakdown = await c.env.DB.prepare(`
            SELECT 
                user_email,
                SUM(token_total) as total_tokens,
                COUNT(*) as events,
                MAX(DATETIME(created_at, '+5 hours', '+30 minutes')) as last_active
            FROM usage_logs
            WHERE DATE(created_at, '+5 hours', '+30 minutes') = DATE('now', '+5 hours', '+30 minutes')
            ${userFilterClause}
            GROUP BY user_email
            ORDER BY total_tokens DESC
        `).bind(...userParams).all();

        // Get Recent Activity (Convert to IST)
        const recentActivity = await c.env.DB.prepare(`
            SELECT 
                id, 
                user_email, 
                event_type, 
                token_total, 
                DATETIME(created_at, '+5 hours', '+30 minutes') as created_at 
            FROM usage_logs 
            WHERE 1=1 ${userFilterClause}
            ORDER BY id DESC 
            LIMIT 20
        `).bind(...userParams).all();

        return c.json({
            allUsers: allUsers.results ? allUsers.results.map(r => r.user_email) : [],
            dailyTotals: dailyTotals.results || [],
            userBreakdown: userBreakdown.results || [],
            recentActivity: recentActivity.results || []
        });
    } catch (error) {
        console.error('Analytics error:', error);
        return c.json({ error: error.message }, 500);
    }
});

export default app;
