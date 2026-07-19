const uploadBlob = require("../../database/uploadimage");

class ProjectReportUploader {

    async uploadToBlobStorage(docxFilePath, id, reportType) {

        const containerName = 'projectreports';
        const uploadOptions = {
            metadata: {
                'uploader': 'umesh',
            },
            tags: {
                'id': id,
                'reportType': reportType
            }
        };
        const fileName = `${id}_${reportType}_${new Date().toISOString().slice(0,19).replace(/[T:]/g, "-")}.docx`;
        let result = await uploadBlob.uploadFile(containerName, fileName, docxFilePath, uploadOptions);
        try{
            const jsonObject = JSON.parse(result);
            if (!jsonObject || !jsonObject.url) {
                throw new Error('Unexpected result from uploadBlob.uploadFile');
            }
            return jsonObject.url;
        }catch(err){
            console.log(err);
        }
        // Ensure result has the 'url' property

    }
}

module.exports = new ProjectReportUploader();
