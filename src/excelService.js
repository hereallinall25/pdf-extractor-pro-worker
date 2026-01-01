import ExcelJS from 'exceljs';

export async function generateExcel(data) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Extracted Data');

    if (data.length === 0) return workbook;

    // Assume data is an array of objects
    // Get headers from the first object
    const headers = Object.keys(data[0]);
    worksheet.columns = headers.map(header => ({ header: header, key: header, width: 20 }));

    // Add rows
    data.forEach(item => {
        worksheet.addRow(item);
    });

    // Style the header
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
    };

    return workbook;
}
