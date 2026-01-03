import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { extractFromPdf } from './vertexAi';
import { generateExcel } from './excelService';

const app = new Hono();

app.use('*', cors());

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
        const pdfFile = body.pdf;
        const customPrompt = body.prompt;

        if (!pdfFile || !(pdfFile instanceof File)) {
            return c.json({ error: 'No PDF file uploaded' }, 400);
        }

        const arrayBuffer = await pdfFile.arrayBuffer();
        const pdfBase64 = Buffer.from(arrayBuffer).toString('base64');

        const extractedData = await extractFromPdf(pdfBase64, customPrompt, c.env);
        return c.json(extractedData);
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
    const { results } = await c.env.DB.prepare('SELECT * FROM prompts ORDER BY created_at DESC').all();
    return c.json(results);
});

app.post('/api/prompts', async (c) => {
    const { name, university, state, type, content } = await c.req.json();
    const result = await c.env.DB.prepare(
        'INSERT INTO prompts (name, university, state, type, content) VALUES (?, ?, ?, ?, ?) RETURNING *'
    )
        .bind(name, university, state, type, content)
        .first();
    return c.json(result);
});

app.put('/api/prompts/:id', async (c) => {
    const id = c.req.param('id');
    const { name, university, state, type, content } = await c.req.json();
    const result = await c.env.DB.prepare(
        'UPDATE prompts SET name = ?, university = ?, state = ?, type = ?, content = ? WHERE id = ? RETURNING *'
    )
        .bind(name, university, state, type, content, id)
        .first();
    return c.json(result);
});

app.delete('/api/prompts/:id', async (c) => {
    const id = c.req.param('id');
    await c.env.DB.prepare('DELETE FROM prompts WHERE id = ?').bind(id).run();
    return c.json({ success: true });
});

export default app;
