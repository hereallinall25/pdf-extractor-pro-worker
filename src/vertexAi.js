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

export async function extractFromPdf(pdfBase64, customPrompt, env) {
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
    parts.push({
        text: customPrompt || 'Extract all relevant information from this question paper and format it as a JSON object suitable for an Excel sheet.',
    });

    const requestBody = {
        contents: [
            {
                role: 'user',
                parts: parts,
            },
        ],
        generationConfig: {
            temperature: 0.1, // Lower temperature for more consistent, less creative output
            maxOutputTokens: 8192, // Increased for long question papers
            responseMimeType: 'application/json',
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

    const data = await response.json();
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        throw new Error('Malformed response from Vertex AI: ' + JSON.stringify(data));
    }

    const text = data.candidates[0].content.parts[0].text;
    const extractedData = parseResponse(text);

    // Optimization: Clear large objects immediately
    const usageInfo = {
        ...data.usageMetadata,
        modelLimit: 1048576,
        maxOutputTokens: requestBody.generationConfig.maxOutputTokens
    };

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
    // 1. Try JSON First
    try {
        const jsonString = text.replace(/```json\n?|```/g, '').trim();
        const parsed = JSON.parse(jsonString);

        // If it's already an array, return it
        if (Array.isArray(parsed)) return parsed;

        // If it's an object with a likely data key, return the array inside it
        if (parsed.questions && Array.isArray(parsed.questions)) return parsed.questions;
        if (parsed.data && Array.isArray(parsed.data)) return parsed.data;
        if (parsed.results && Array.isArray(parsed.results)) return parsed.results;

        // Otherwise, return it as a single-row array for safety
        return [parsed];
    } catch (e) {
        console.log("JSON parse failed, attempting pipe-separated parsing...");
    }

    // 2. Try Pipe-Separated Values (PSV)
    try {
        const lines = text.trim().split('\n').filter(line => line.trim() !== '');
        if (lines.length === 0) throw new Error("Empty response");

        const standardHeaders = [
            "S.No", "Question", "Paper", "Subject", "Month Year",
            "Type", "Section", "University Name", "CBME", "Supplementary"
        ];

        let headers;
        let startIdx;

        // Detect if first line is a header or data
        const firstLine = lines[0].toLowerCase();
        if (firstLine.includes('s.no') || firstLine.includes('question')) {
            headers = lines[0].split('|').map(h => h.trim()).filter(h => h !== '');
            startIdx = 1;
        } else {
            // No header found, use standard schema
            headers = standardHeaders;
            startIdx = 0;
        }

        const data = [];
        for (let i = startIdx; i < lines.length; i++) {
            const values = lines[i].split('|').map(v => v.trim());
            if (values.length > 1) { // Ensure it's a valid row
                const row = {};
                headers.forEach((header, index) => {
                    // Map values to headers; if extra values exist, ignore them; if missing, use blank
                    row[header] = values[index] || '';
                });
                data.push(row);
            }
        }

        if (data.length === 0) throw new Error("No data rows extracted");
        return data;

    } catch (e) {
        console.error('Failed to parse response:', text);
        throw new Error('Could not parse AI response. Raw Text: ' + text.substring(0, 500));
    }
}
