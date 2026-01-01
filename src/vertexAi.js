import { VertexAI } from '@google-cloud/vertexai';

export async function extractFromPdf(pdfBase64, customPrompt, env) {
    const project = env.GOOGLE_CLOUD_PROJECT || 'your-project-id';
    const location = env.GOOGLE_CLOUD_LOCATION || 'us-central1';

    const vertexAI = new VertexAI({ project: project, location: location });
    const modelName = 'gemini-2.5-flash-lite';

    const generativeModel = vertexAI.getGenerativeModel({
        model: modelName,
    });

    const filePart = {
        inlineData: {
            data: pdfBase64,
            mimeType: 'application/pdf',
        },
    };

    const textPart = {
        text: customPrompt || 'Extract all relevant information from this question paper and format it as a JSON object suitable for an Excel sheet.',
    };

    const request = {
        contents: [{ role: 'user', parts: [filePart, textPart] }],
        // removed responseMimeType to allow flexible output (JSON or Text)
    };

    const result = await generativeModel.generateContent(request);
    const response = result.response;
    const text = response.candidates[0].content.parts[0].text;

    return parseResponse(text);
}

function parseResponse(text) {
    // 1. Try JSON First
    try {
        // Clean up potential markdown code blocks (```json ... ```)
        const jsonString = text.replace(/```json\n?|```/g, '').trim();
        return JSON.parse(jsonString);
    } catch (e) {
        console.log("JSON parse failed, attempting pipe-separated parsing...");
    }

    // 2. Try Pipe-Separated Values (PSV)
    try {
        const lines = text.trim().split('\n').filter(line => line.trim() !== '');
        if (lines.length < 2) throw new Error("Not enough lines for a table");

        // Identify separator (simple pipe detection)
        if (!lines[0].includes('|')) throw new Error("No pipe separator found");

        const headers = lines[0].split('|').map(h => h.trim()).filter(h => h !== '');
        const data = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split('|').map(v => v.trim()).filter(v => v !== '');
            // Simple validation: must have roughly same number of columns, or at least 1
            if (values.length > 0) {
                const row = {};
                headers.forEach((header, index) => {
                    row[header] = values[index] || '';
                });
                data.push(row);
            }
        }

        if (data.length === 0) throw new Error("No data rows extracted");
        return data;

    } catch (e) {
        console.error('Failed to parse response:', text);
        throw new Error('Could not parse AI response as JSON or Table. Response: ' + text.substring(0, 100) + '...');
    }
}

