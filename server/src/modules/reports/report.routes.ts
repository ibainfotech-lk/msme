import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireCheckoutOrigin } from "../../middleware/checkout-origin.middleware";
import { saveImmutableCashReport, ReportSnapshotError } from "./immutable-report-snapshot.service";
import { loadPreviouslyGeneratedPdf, ArchivedReportError } from "./archived-report-download.service";
import {
  previewCashbookReport,CashbookReportError,
} from "./cashbook-report.service";

/** F.17.3: read-only on-demand report previews, never saved/PDF, dev only. */
const router=Router();
router.use((_req,res,next)=>{
  if(process.env.NODE_ENV!=="development" ||
     process.env.NOTETO_F17_REPORT_PREVIEW_ENABLED!=="true"){
    res.status(503).json({success:false,code:"REPORTS_NOT_AVAILABLE"});
    return;
  }
  next();
});
router.use(requireAuth);
const params=z.strictObject({businessId:z.uuid()});
const pdfRef=z.strictObject({businessId:z.uuid(),snapshotId:z.uuid()});
const snapshotBody=z.strictObject({
  snapshotId:z.uuid(),
  period:z.enum(["DAILY","WEEKLY","YEARLY"]),
  periodKey:z.string(),
});
const query=z.strictObject({
  period:z.enum(["DAILY","WEEKLY","YEARLY"]),
  periodKey:z.string(),
});
function failed(e:unknown,res:Response,next:NextFunction):void{
  if(e instanceof ReportSnapshotError||e instanceof ArchivedReportError){
    res.status(e.statusCode).json({success:false,code:e.code});
  }else if(e instanceof CashbookReportError){
    res.status(e.statusCode).json({success:false,code:e.code});
  }else next(e);
}
router.get("/businesses/:businessId/preview",async(req,res,next)=>{
  const p=params.safeParse(req.params),q=query.safeParse(req.query);
  if(!p.success||!q.success){
    res.status(400).json({success:false,code:"INVALID_REPORT_REQUEST"});return;
  }
  try{
    const result=await previewCashbookReport({
      businessId:p.data.businessId,userId:req.session.userId!,...q.data,
    });
    res.set("Cache-Control","private, no-store");
    res.json({success:true,report:result});
  }catch(e){failed(e,res,next);}
});
router.post("/businesses/:businessId/snapshots",requireCheckoutOrigin,
  async(req,res,next)=>{
    const p=params.safeParse(req.params),b=snapshotBody.safeParse(req.body);
    if(!p.success||!b.success){
      res.status(400).json({success:false,code:"INVALID_REPORT_SNAPSHOT_REFERENCE"});return;
    }
    try{
      const result=await saveImmutableCashReport({
        businessId:p.data.businessId,userId:req.session.userId!,...b.data,
      });
      res.set("Cache-Control","private, no-store");
      res.status(result.replayed?200:201).json({success:true,snapshot:result});
    }catch(e){failed(e,res,next);}
  }
);
router.get("/businesses/:businessId/snapshots/:snapshotId/pdf",async(req,res,next)=>{
  const p=pdfRef.safeParse(req.params);
  if(!p.success){
    res.status(400).json({success:false,code:"INVALID_REPORT_SNAPSHOT_REFERENCE"});return;
  }
  try{
    const pdf=await loadPreviouslyGeneratedPdf({
      businessId:p.data.businessId,userId:req.session.userId!,
      reportId:p.data.snapshotId,
    });
    res.set({
      "Cache-Control":"private, no-store",
      "Content-Type":"application/pdf",
      "Content-Disposition":`attachment; filename="${pdf.filename}"`,
      "X-Content-Type-Options":"nosniff",
      "Content-Length":String(pdf.bytes.length),
    });
    res.end(pdf.bytes);
  }catch(e){failed(e,res,next);}
});
router.use((_req,res)=>{
  res.status(405).json({success:false,code:"REPORT_ACTION_DISABLED"});
});
export default router;
