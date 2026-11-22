import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireCheckoutOrigin } from "../../middleware/checkout-origin.middleware";
import {
  issueInvoice, listInvoices, getInvoice, InvoiceIssueError,
} from "./invoice-issuance.service";

/** F.17.2 — private development-only routes, never production-enabled. */
const router = Router();
router.use((_req,res,next)=>{
  if(process.env.NODE_ENV!=="development"||
     process.env.NOTETO_F17_INVOICING_ENABLED!=="true"){
    res.status(503).json({success:false,code:"INVOICING_NOT_AVAILABLE"});
    return;
  }
  next();
});
router.use(requireAuth);

const businessRef=z.strictObject({businessId:z.uuid()});
const invoiceRef=z.strictObject({businessId:z.uuid(),invoiceId:z.uuid()});
const lineSchema=z.strictObject({
  description:z.string(),quantity:z.string(),unitPriceLkr:z.string(),
});
const createSchema=z.strictObject({
  customerName:z.string(),
  customerEmail:z.string().nullable().optional(),
  notes:z.string().optional(),
  lines:z.array(lineSchema).min(1).max(20),
  idempotencyKey:z.string(),
});
const listQuery=z.strictObject({
  limit:z.coerce.number().int().min(1).max(100).optional(),
  cursorCreatedAt:z.string().optional(),
  cursorId:z.uuid().optional(),
});
function failed(e:unknown,res:Response,next:NextFunction):void{
  if(e instanceof InvoiceIssueError){
    res.status(e.statusCode).json({success:false,code:e.code});
  }else next(e);
}
router.get("/businesses/:businessId",async(req,res,next)=>{
  const p=businessRef.safeParse(req.params);
  const q=listQuery.safeParse(req.query);
  if(!p.success||!q.success||
     Boolean(q.data.cursorCreatedAt)!==Boolean(q.data.cursorId)){
    res.status(400).json({success:false,code:"INVALID_INVOICE_PAGE"});return;
  }
  try{
    const result=await listInvoices({
      businessId:p.data.businessId,userId:req.session.userId!,
      limit:q.data.limit,
      cursor:q.data.cursorId&&q.data.cursorCreatedAt?
        {id:q.data.cursorId,createdAt:q.data.cursorCreatedAt}:undefined,
    });
    res.set("Cache-Control","private, no-store");
    res.json({success:true,...result});
  }catch(e){failed(e,res,next);}
});
router.get("/businesses/:businessId/:invoiceId",async(req,res,next)=>{
  const p=invoiceRef.safeParse(req.params);
  if(!p.success){res.status(400).json({success:false,code:"INVALID_INVOICE_REFERENCE"});return;}
  try{
    const result=await getInvoice({
      businessId:p.data.businessId,userId:req.session.userId!,
      invoiceId:p.data.invoiceId,
    });
    res.set("Cache-Control","private, no-store");
    res.json({success:true,invoice:result});
  }catch(e){failed(e,res,next);}
});
router.post("/businesses/:businessId",requireCheckoutOrigin,async(req,res,next)=>{
  const p=businessRef.safeParse(req.params);
  const b=createSchema.safeParse(req.body);
  if(!p.success||!b.success){
    res.status(400).json({success:false,code:"INVALID_INVOICE"});return;
  }
  try{
    const result=await issueInvoice({
      businessId:p.data.businessId,userId:req.session.userId!,...b.data,
    });
    res.set("Cache-Control","private, no-store");
    res.status(result.replayed?200:201).json({success:true,invoice:result});
  }catch(e){failed(e,res,next);}
});
router.use((_req,res)=>{
  res.status(405).json({success:false,code:"INVOICE_ACTION_DISABLED"});
});
export default router;
