import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { extractFromPdf, chatWithGemini } from './vertexAi';
import { generateExcel } from './excelService';

const app = new Hono();

app.use('*', cors());
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
        const userEmail = c.req.header('Cf-Access-Authenticated-User-Email') || 'anonymous@internal.com';
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

        if (!pdfFile || !(pdfFile instanceof File)) {
            return c.json({ error: 'No file uploaded' }, 400);
        }

        const arrayBuffer = await pdfFile.arrayBuffer();
        const pdfBase64 = Buffer.from(arrayBuffer).toString('base64');

        const { data, usage } = await extractFromPdf(pdfBase64, customPrompt, c.env);

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
        // Get Daily Totals
        const dailyTotals = await c.env.DB.prepare(`
            SELECT 
                DATE(created_at) as date,
                SUM(token_total) as total_tokens,
                COUNT(CASE WHEN event_type = 'extraction' THEN 1 END) as extractions,
                COUNT(CASE WHEN event_type = 'chat' THEN 1 END) as chats,
                COUNT(DISTINCT user_email) as active_users
            FROM usage_logs
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at) DESC
            LIMIT 30
        `).all();

        // Get User Breakdown (Today)
        const userBreakdown = await c.env.DB.prepare(`
            SELECT 
                user_email,
                SUM(token_total) as total_tokens,
                COUNT(*) as events,
                MAX(created_at) as last_active
            FROM usage_logs
            WHERE DATE(created_at) = DATE('now')
            GROUP BY user_email
            ORDER BY total_tokens DESC
        `).all();

        // Get Recent Activity
        const recentActivity = await c.env.DB.prepare(`
            SELECT * FROM usage_logs 
            ORDER BY created_at DESC 
            LIMIT 20
        `).all();

        return c.json({
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
