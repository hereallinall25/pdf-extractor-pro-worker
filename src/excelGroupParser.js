import * as XLSX from 'xlsx';

export async function processExcelMerge(buffer) {
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    if (!worksheet) {
        throw new Error("No worksheet found in the Excel file");
    }

    // Convert to JSON array of arrays (header becomes first row)
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (!jsonData || jsonData.length < 2) {
         throw new Error("Excel is empty or missing headers");
    }

    const headers = jsonData[0];
    const rows = [];
    rows.headers = headers;
    
    // Find optimal columns
    let qNumIdx = -1;
    let qTextIdx = -1;
    
    headers.forEach((h, idx) => {
        const headerStr = String(h || '').toLowerCase();
        if (headerStr.includes('no') || headerStr.includes('num') || headerStr === 'q') qNumIdx = idx;
        if (headerStr.includes('question') || headerStr.includes('text')) qTextIdx = idx;
    });
    
    if (qNumIdx === -1) qNumIdx = 0; 
    if (qTextIdx === -1) qTextIdx = Math.min(1, headers.length - 1); 

    for (let i = 1; i < jsonData.length; i++) {
        const rowArr = jsonData[i];
        
        // Skip empty rows
        if (!rowArr || rowArr.length === 0) continue;
        
        const qNum = String(rowArr[qNumIdx] || '').trim();
        const qText = String(rowArr[qTextIdx] || '').trim();
        
        if (qNum || qText) {
            const rootMatch = qNum.match(/^(\d+)/);
            const rootNum = rootMatch ? rootMatch[1] : qNum;
            
            rows.push({
                original_row: i + 1,
                root_num: rootNum,
                q_num: qNum,
                q_text: qText,
                full_data: rowArr // array format
            });
        }
    }

    // Group by root number
    const groups = {};
    const orderedRoots = [];
    
    rows.forEach(r => {
        if (!groups[r.root_num]) {
            groups[r.root_num] = [];
            orderedRoots.push(r.root_num);
        }
        groups[r.root_num].push(r);
    });

    return {
        headers: rows.headers,
        groups,
        orderedRoots,
        totalParsed: rows.length
    };
}
