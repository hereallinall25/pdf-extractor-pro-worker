import * as jose from 'jose';

async function getAccessToken(env) {
    if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
        throw new Error('GOOGLE_APPLICATION_CREDENTIALS secret is missing');
    }

    let credentials;
    try {
        const credsStr = (env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
        credentials = JSON.parse(credsStr);
    } catch (e) {
        throw new Error(`GOOGLE_APPLICATION_CREDENTIALS is not a valid JSON string. (Error: ${e.message})`);
    }

    const { client_email, private_key } = credentials;
    if (!client_email || !private_key) {
        throw new Error('GOOGLE_APPLICATION_CREDENTIALS must contain client_email and private_key');
    }

    // Sign the JWT for Google OAuth2
    const key = await jose.importPKCS8(private_key, 'RS256');
    const jwt = await new jose.SignJWT({
        iss: client_email,
        sub: client_email,
        aud: 'https://oauth2.googleapis.com/token',
        scope: 'https://www.googleapis.com/auth/cloud-platform',
    })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key);

    // Exchange JWT for Access Token
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt,
        }),
    });

    const data = await response.json();
    if (data.error) {
        throw new Error(`Google Auth Error: ${data.error_description || data.error}`);
    }
    return data.access_token;
}

export async function extractFromPdf(pdfBase64, customPrompt, temperature, env) {
    const project = env.GOOGLE_CLOUD_PROJECT || 'pdf-extractor-pro-483018';
    const location = env.GOOGLE_CLOUD_LOCATION || 'asia-south1';

    // Strictly using only Gemini 2.5 Flash-Lite as requested
    const model = 'gemini-2.5-flash-lite';

    console.log(`Starting extraction using ${model} for project: ${project}`);

    const accessToken = await getAccessToken(env);
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

    const parts = [];
    if (pdfBase64) {
        parts.push({
            inlineData: {
                mimeType: 'application/pdf',
                data: pdfBase64,
            },
        });
    }
    let requestBody = {
        contents: [
            {
                role: 'user',
                parts: [
                    ...parts,
                    {
                        text: "You are a highly strict data extraction assistant. Your ONLY job is to extract text exactly as it appears in the provided document.\n\n" +
                            (customPrompt || 'Extract all relevant information from this question paper. Format the output as a JSON array of objects. For very long papers, you may use a Pipe-Separated list (PSV) with headers to stay within limits. Columns: S.No, Question, Paper, Subject, Month Year, Type, Section, University Name, CBME, Supplementary.') +
                            '\n\nCRITICAL INSTRUCTIONS:\n1. ONLY extract information that is explicitly written in the provided document.\n2. Do NOT invent, hallucinate, guess, or add any extra questions, subjects, or data.\n3. Stop generating immediately once you reach the end of the document text. Do NOT append your own examples.'
                    }
                ],
            },
        ],
        generationConfig: {
            temperature: typeof temperature === 'number' && !isNaN(temperature) ? temperature : 0.0,
            maxOutputTokens: 65535,
        },
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Vertex AI Error: ${JSON.stringify(errorData)}`);
    }

    let responseData = await response.json();
    if (!responseData.candidates || !responseData.candidates[0] || !responseData.candidates[0].content) {
        throw new Error('Malformed response from Vertex AI: ' + JSON.stringify(responseData));
    }

    const text = responseData.candidates[0].content.parts[0].text;
    const extractedData = parseResponse(text);

    // Optimization: Clear large objects immediately
    const usageInfo = {
        ...responseData.usageMetadata,
        modelLimit: 1048576,
        maxOutputTokens: requestBody.generationConfig.maxOutputTokens
    };

    // Nullify huge objects to free memory in Cloudflare Worker
    pdfBase64 = null;
    requestBody = null;
    responseData = null;

    return {
        data: extractedData,
        usage: usageInfo
    };
}

/**
 * Multi-turn chat with Gemini, supporting file attachments and prompt context.
 * @param {Array} messages - Array of { role: 'user' | 'model', content: string }
 * @param {Array} attachments - Array of { mimeType: string, base64: string }
 * @param {string} promptContext - Optional system prompt/context
 * @param {object} env - Cloudflare environment bindings
 */
export async function chatWithGemini(messages, attachments, promptContext, env) {
    const project = env.GOOGLE_CLOUD_PROJECT || 'pdf-extractor-pro-483018';
    const location = env.GOOGLE_CLOUD_LOCATION || 'asia-south1';
    const model = 'gemini-2.5-flash-lite';

    const accessToken = await getAccessToken(env);
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

    // Build the contents array for multi-turn conversation
    const contents = [];

    // Add system context as the first "user" message if provided
    if (promptContext) {
        contents.push({
            role: 'user',
            parts: [{ text: `[System Context - Current Prompt]:\n${promptContext}\n\n---\nYou are a helpful AI assistant. Use the above prompt as context to help the user refine it or answer questions about attached files.` }]
        });
        contents.push({
            role: 'model',
            parts: [{ text: 'Understood. I have the prompt context loaded. How can I help you?' }]
        });
    }

    // Add conversation history
    for (const msg of messages) {
        const parts = [];

        // For the latest user message, include attachments
        if (msg.role === 'user' && msg === messages[messages.length - 1] && attachments && attachments.length > 0) {
            for (const att of attachments) {
                parts.push({
                    inlineData: {
                        mimeType: att.mimeType,
                        data: att.base64
                    }
                });
            }
        }

        parts.push({ text: msg.content });
        contents.push({ role: msg.role, parts });
    }

    const requestBody = {
        contents,
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 4096
        }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Gemini API Error: ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        throw new Error('Malformed response from Gemini: ' + JSON.stringify(data));
    }

    const reply = data.candidates[0].content.parts[0].text;
    return { reply, usage: data.usageMetadata };
}

function parseResponse(text) {
    if (!text) throw new Error("Empty response from AI");

    // 1. Try to extract JSON from code blocks or loose text
    let jsonString = text.trim();
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
        jsonString = jsonMatch[1] || jsonMatch[0];
    } else {
        // Fallback: strip backticks if any
        jsonString = jsonString.replace(/```json\n?|```/g, '').trim();
    }

    try {
        const parsed = JSON.parse(jsonString);
        if (Array.isArray(parsed)) return parsed;
        if (parsed.questions && Array.isArray(parsed.questions)) return parsed.questions;
        if (parsed.data && Array.isArray(parsed.data)) return parsed.data;
        if (parsed.results && Array.isArray(parsed.results)) return parsed.results;
        return [parsed];
    } catch (e) {
        // If JSON fails, it might be truncated. Try to "fix" it if it's an array
        if (jsonString.startsWith('[') && !jsonString.endsWith(']')) {
            try {
                const lastBrace = jsonString.lastIndexOf('}');
                if (lastBrace !== -1) {
                    const fixed = jsonString.substring(0, lastBrace + 1) + ']';
                    return JSON.parse(fixed);
                }
            } catch (innerE) { /* ignore */ }
        }
        console.log("JSON parse failed or truncated, attempting PSV parsing...");
    }

    // 2. Try Pipe-Separated Values (PSV)
    try {
        const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l !== '');
        if (lines.length === 0) throw new Error("No text lines found");

        const standardHeaders = [
            "S.No", "Question", "Paper", "Subject", "Month Year",
            "Type", "Section", "University Name", "CBME", "Supplementary"
        ];

        let headers = standardHeaders;
        let startIdx = 0;

        // Header detection
        const firstLine = lines[0].toLowerCase();
        if (firstLine.includes('|') && (firstLine.includes('question') || firstLine.includes('s.no'))) {
            headers = lines[0].split('|').map(h => h.trim()).filter(h => h !== '');
            startIdx = 1;
        }

        const data = [];
        for (let i = startIdx; i < lines.length; i++) {
            const line = lines[i];
            if (!line.includes('|')) continue;

            const values = line.split('|').map(v => v.trim());
            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index] || '';
            });
            data.push(row);
        }

        if (data.length > 0) return data;

    } catch (e) {
        console.error('PSV parse failed:', e);
    }

    throw new Error('Could not parse AI response. It may be too long or truncated. Try using a shorter prompt or manually re-running this file. Raw snippet: ' + text.substring(0, 300) + '...');
}
