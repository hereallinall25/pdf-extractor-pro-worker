import * as XLSX from 'xlsx';

export async function generateExcel(data) {
    // Generate a simple workbook buffer
    if (!data || data.length === 0) {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{}]), "Extracted Data");
        return ExcelToBuffer(wb);
    }

    const worksheet = XLSX.utils.json_to_sheet(data);

    // Get all unique keys from all objects (json_to_sheet handles this somewhat, but we can verify)
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Extracted Data');

    // Return ArrayBuffer or Buffer. SheetJS writes base64 or array directly.
    return ExcelToBuffer(workbook);
}

function ExcelToBuffer(wb) {
     const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
     return Buffer.from(wbout);
}
