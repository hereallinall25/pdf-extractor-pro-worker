import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { extractFromPdf } from './vertexAi';
import { generateExcel } from './excelService';

const app = new Hono();

app.use('*', cors());

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
        const pdfBase64 = btoa(
            new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );

        const extractedData = await extractFromPdf(pdfBase64, customPrompt, c.env);
        return c.json(extractedData);
    } catch (error) {
        console.error('Extraction error:', error);
        return c.json({ error: error.message }, 500);
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
    const { name, subject, type, content } = await c.req.json();
    const result = await c.env.DB.prepare(
        'INSERT INTO prompts (name, subject, type, content) VALUES (?, ?, ?, ?) RETURNING *'
    )
        .bind(name, subject, type, content)
        .first();
    return c.json(result);
});

app.delete('/api/prompts/:id', async (c) => {
    const id = c.req.param('id');
    await c.env.DB.prepare('DELETE FROM prompts WHERE id = ?').bind(id).run();
    return c.json({ success: true });
});

export default app;
