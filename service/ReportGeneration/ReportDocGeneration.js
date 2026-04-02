const fs = require("fs");
const ReportGenerationUtil = require("./ReportGenerationUtil.js");
const ProjectReportType = require("../../model/projectReportType");
class ReportDocGeneration {
    async generateReportDoc(projectId, project,companyName,sectionImageProperties,reportType){
        try{
            console.time("generateReportDocs");
            const template = this.getTemplate(companyName);

            const createdAtString = project.createdat || project.createdAt;
            const date = new Date(createdAtString);
            const data = {
                project:{
                    reportType: reportType,
                    name: project.name,
                    address: project.address,
                    description: project.description,
                    createdBy: project.createdby,
                    createdAt : date.toLocaleString(),
                    headerName: this.getProjectHeader(reportType)
                }
            };
            const filePath = projectId + '-projectheader.docx'
            const additionalJsContext = {
                tile: async () => {
                    const projurl = project.url === '' ? 'https://www.deckinspectors.com/wp-content/uploads/2020/07/logo_new_new-1.png' :
                        project.url;
                    const resp = await fetch(
                        projurl
                    );
                    const buffer = resp.arrayBuffer
                        ? await resp.arrayBuffer()
                        : await resp.buffer();
                    return { height: 15,width: 19.8,  data: buffer, extension: '.png' };
                },
            };
            const buffer = await ReportGenerationUtil.createDocReportWithParams(template,data,additionalJsContext)
            fs.writeFileSync(filePath, buffer);
            return filePath;
        }
        catch(err){
            console.log(err);
        }
    }
    getTemplate(companyName) {
        if (companyName === 'Wicr') {
            return fs.readFileSync('WicrProjectHeader.docx');
        } else {
            return fs.readFileSync('DeckProjectHeader.docx');
        }
    }
    getProjectHeader(reportType){
        if(ProjectReportType.VISUALREPORT === reportType)
        {
            return "Visual Inspection Report";
        }
        else if(ProjectReportType.INVASIVEONLY === reportType)
        {
            return "Invasive only Project Report";
        }
        else if(ProjectReportType.INVASIVEVISUAL === reportType)
        {
            return "Invasive Project Report";
        }
    }
}

module.exports = new ReportDocGeneration();