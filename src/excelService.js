import ExcelJS from 'exceljs';

export async function generateExcel(data) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Extracted Data');

    if (data.length === 0) return workbook;

    // Assume data is an array of objects
    if (!data || data.length === 0) return workbook;

    // Get all unique keys from all objects to ensure no data is lost
    const allKeys = new Set();
    data.forEach(item => Object.keys(item).forEach(key => allKeys.add(key)));
    const headers = Array.from(allKeys);

    worksheet.columns = headers.map(header => {
        let width = 20;
        if (header.toLowerCase().includes('question')) width = 80;
        if (header.toLowerCase().includes('s.no')) width = 8;
        return { header: header, key: header, width: width };
    });

    // Add rows
    data.forEach(item => {
        worksheet.addRow(item);
    });

    // Style the header and enable text wrapping for question column
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
    };

    // Enable text wrapping for all cells in columns that contain 'Question'
    worksheet.columns.forEach(col => {
        if (col.header.toLowerCase().includes('question')) {
            col.style = { alignment: { wrapText: true, vertical: 'top' } };
        } else {
            col.style = { alignment: { vertical: 'top' } };
        }
    });

    return workbook;
}
