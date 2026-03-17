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

    // Group by contiguous Blocks (resetting when root number goes backwards or stays same across papers)
    const groups = {};
    const orderedRoots = [];
    
    let currentBlockId = 1;
    let lastRootNum = 0;

    rows.forEach(r => {
        // Convert to integer for accurate numerical comparison (e.g., 10 > 9, not string '10' < '9')
        const currentRootNum = parseInt(r.root_num, 10);
        
        // If the current root number drops (e.g., 10 -> 1) or stays exactly the same but isn't a subquestion
        // it means we've hit a new question paper block.
        if (!isNaN(currentRootNum) && currentRootNum <= lastRootNum) {
            // Only increment block if it genuinely dropped backwards, 
            // OR if it's the exact same root number but we are forcing a split.
            // Note: Since subquestions (1a, 1b) share the same root_num, currentRootNum == lastRootNum 
            // is expected WITHIN a block. So we only break if it STRICTLY drops (current < last).
            if (currentRootNum < lastRootNum) {
                currentBlockId++;
            }
        }
        
        // Update lastRootNum tracking regardless
        if (!isNaN(currentRootNum)) {
            lastRootNum = currentRootNum;
        }

        // Unique Group ID = Block # + Root Number
        const currentGroupId = `block_${currentBlockId}_root_${r.root_num}`;
        
        if (!groups[currentGroupId]) {
            orderedRoots.push(currentGroupId);
            groups[currentGroupId] = [];
        }
        
        groups[currentGroupId].push(r);
    });

    return {
        headers: rows.headers,
        groups,
        orderedRoots, // Keep the same variable name for compatibility in index.js
        totalParsed: rows.length
    };
}
