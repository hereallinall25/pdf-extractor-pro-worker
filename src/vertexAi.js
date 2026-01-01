import * as jose from 'jose';

async function getAccessToken(env) {
    if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
        throw new Error('GOOGLE_APPLICATION_CREDENTIALS secret is missing');
    }

    let credentials;
    try {
        credentials = JSON.parse(env.GOOGLE_APPLICATION_CREDENTIALS);
    } catch (e) {
        throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not a valid JSON string');
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

    const requestBody = {
        contents: [
            {
                role: 'user',
                parts: [
                    {
                        inlineData: {
                            mimeType: 'application/pdf',
                            data: pdfBase64,
                        },
                    },
                    {
                        text: customPrompt || 'Extract all relevant information from this question paper and format it as a JSON object suitable for an Excel sheet.',
                    },
                ],
            },
        ],
        generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
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
    return parseResponse(text);
}

function parseResponse(text) {
    // 1. Try JSON First
    try {
        const jsonString = text.replace(/```json\n?|```/g, '').trim();
        return JSON.parse(jsonString);
    } catch (e) {
        console.log("JSON parse failed, attempting pipe-separated parsing...");
    }

    // 2. Try Pipe-Separated Values (PSV)
    try {
        const lines = text.trim().split('\n').filter(line => line.trim() !== '');
        if (lines.length < 2) throw new Error("Not enough lines for a table");

        if (!lines[0].includes('|')) throw new Error("No pipe separator found");

        const headers = lines[0].split('|').map(h => h.trim()).filter(h => h !== '');
        const data = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split('|').map(v => v.trim()).filter(v => v !== '');
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
        throw new Error('Could not parse AI response. Raw Text: ' + text.substring(0, 500));
    }
}
