import { Router,type NextFunction,type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireCheckoutOrigin } from "../../middleware/checkout-origin.middleware";
import { viewTaxReadiness,TaxReadinessError } from "./tax-readiness.service";
import { getTaxSourceCoverage } from "./tax-rule-source-coverage.service";
import { readTaxIntakeDraft,saveTaxIntakeDraft,type TaxIntakeClaims } from "./taxpayer-intake-draft.service";

const router=Router();
/** F.17.4a — read-only and always disabled in production. */
router.use((_req,res,next)=>{
  if(process.env.NODE_ENV!=="development"||
     process.env.NOTETO_F17_TAX_READINESS_ENABLED!=="true"){
    res.status(503).json({success:false,code:"TAX_READINESS_DISABLED"});return;
  }
  next();
});
router.use(requireAuth);
const params=z.strictObject({businessId:z.uuid()});
const query=z.strictObject({
  assessmentYearStart:z.coerce.number().int().min(2025),
});
const answer=z.enum(["UNKNOWN","YES","NO","NOT_SURE"]);
const claims=z.strictObject({
  taxpayerCategoryClaim:z.enum(["UNKNOWN","INDIVIDUAL","COMPANY","OTHER_ENTITY","NOT_SURE"]),
  residencyClaim:z.enum(["UNKNOWN","RESIDENT","NON_RESIDENT","NOT_SURE"]),
  otherIncomeClaim:answer,capitalAssetsClaim:answer,
  nonDeductibleCostsClaim:answer,withholdingCreditsClaim:answer,
  ownerIsTaxpayerClaim:answer,
});
const body=z.strictObject({
  assessmentYearStart:z.number().int().min(2025),
  expectedRevision:z.union([z.number().int().min(1),z.null()]),
  claims,
});
function failed(error:unknown,res:Response,next:NextFunction):void{
  if(error instanceof TaxReadinessError){
    res.status(error.statusCode).json({success:false,code:error.code});
  }else next(error);
}
router.get("/businesses/:businessId/readiness",async(req,res,next)=>{
  const p=params.safeParse(req.params),q=query.safeParse(req.query);
  if(!p.success||!q.success){
    res.status(400).json({success:false,code:"INVALID_TAX_READINESS_REQUEST"});return;
  }
  try{
    const result=await viewTaxReadiness({
      businessId:p.data.businessId,userId:req.session.userId!,...q.data,
    });
    res.set("Cache-Control","private, no-store");
    res.json({success:true,readiness:result});
  }catch(e){failed(e,res,next);}
});
router.get("/businesses/:businessId/sources",async(req,res,next)=>{
  const p=params.safeParse(req.params),q=query.safeParse(req.query);
  if(!p.success||!q.success){
    res.status(400).json({success:false,code:"INVALID_TAX_READINESS_REQUEST"});return;
  }
  try{
    const result=await getTaxSourceCoverage({
      businessId:p.data.businessId,userId:req.session.userId!,...q.data,
    });
    res.set("Cache-Control","private, no-store");
    res.json({success:true,coverage:result});
  }catch(e){failed(e,res,next);}
});
router.get("/businesses/:businessId/intake",async(req,res,next)=>{
  const p=params.safeParse(req.params),q=query.safeParse(req.query);
  if(!p.success||!q.success){
    res.status(400).json({success:false,code:"INVALID_TAX_INTAKE_REQUEST"});return;
  }
  try{
    const intake=await readTaxIntakeDraft({
      businessId:p.data.businessId,userId:req.session.userId!,...q.data,
    });
    res.set("Cache-Control","private, no-store");
    res.json({success:true,intake});
  }catch(e){failed(e,res,next);}
});
router.put("/businesses/:businessId/intake",requireCheckoutOrigin,async(req,res,next)=>{
  const p=params.safeParse(req.params),b=body.safeParse(req.body);
  if(!p.success||!b.success){
    res.status(400).json({success:false,code:"INVALID_TAX_INTAKE_REQUEST"});return;
  }
  try{
    const intake=await saveTaxIntakeDraft({
      businessId:p.data.businessId,userId:req.session.userId!,
      assessmentYearStart:b.data.assessmentYearStart,
      expectedRevision:b.data.expectedRevision,claims:b.data.claims as TaxIntakeClaims,
    });
    res.set("Cache-Control","private, no-store");
    res.json({success:true,intake});
  }catch(e){failed(e,res,next);}
});
router.use((_req,res)=>{
  res.status(405).json({success:false,code:"TAX_WRITE_NOT_AVAILABLE"});
});
export default router;
