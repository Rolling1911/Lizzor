import { Router } from "express";
import { z } from "zod";
import { eq, ilike, or } from "drizzle-orm";
import { getCookie, GUEST_CART_COOKIE } from "../auth/cookies.js";
import { getDatabase, getDatabasePool } from "../db/client.js";
import { auditLogs, companies, users } from "../db/schema.js";
import { requireAdmin, requireAuth, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { validateBody } from "../middleware/validate.js";
import { getEuropeanCountry } from "../../shared/europeanCountries.js";
import { acceptInvite, changeMember, claimGuestOrder, companyDetail, createCompany, deleteAddress, invite, listAddresses, listCompanies, listInvitations, resendInvitation, revokeInvitation, saveAddress, selectCompany, updateCompany } from "../accounts/service.js";

const uuid = z.string().uuid();
const optionalText = (max: number) => z.preprocess(value => typeof value === "string" && value.trim() === "" ? null : value, z.string().trim().max(max).nullable().optional());
const countryCode = z.string().trim().length(2, "Select a country.").transform(x=>x.toUpperCase());
export const accountAddressSchema = z.object({ type:z.enum(["billing","shipping"]), firstName:z.string().trim().min(1, "First name is required.").max(100), lastName:z.string().trim().min(1, "Last name is required.").max(100), companyName:optionalText(200), addressLine1:z.string().trim().min(1, "Address line is required.").max(200), addressLine2:optionalText(200), city:z.string().trim().min(1, "City is required.").max(100), postalCode:z.string().trim().min(1, "Postal code is required.").max(30), region:optionalText(100), countryCode, phone:optionalText(50), isDefault:z.boolean().optional() });
const company = z.object({ companyName:z.string().trim().min(1).max(200), registrationNumber:z.string().trim().max(100).nullable().optional(), contactPerson:z.string().trim().min(1).max(200), phone:z.string().trim().max(50).nullable().optional(), email:z.string().trim().email().max(320).transform(x=>x.toLowerCase()), countryCode:z.string().trim().length(2).transform(x=>x.toUpperCase()).nullable().optional() });
export const accountCompanyCreateSchema = z.object({
  companyName:z.string().trim().min(1, "Company name is required.").max(200),
  countryCode:countryCode.refine(value => Boolean(getEuropeanCountry(value)), "Select a supported European country."),
  vatNumber:optionalText(50),
  registrationNumber:optionalText(100),
  phone:optionalText(50),
  billingAddressLine1:optionalText(200),
  billingAddressLine2:optionalText(200),
  billingCity:optionalText(100),
  billingPostalCode:optionalText(30),
  billingRegion:optionalText(100),
}).superRefine((input, context) => {
  const hasBilling = Boolean(input.billingAddressLine1 || input.billingAddressLine2 || input.billingCity || input.billingPostalCode || input.billingRegion);
  if (!hasBilling) return;
  if (!input.billingAddressLine1) context.addIssue({ code:"custom", path:["billingAddressLine1"], message:"Billing address line is required." });
  if (!input.billingCity) context.addIssue({ code:"custom", path:["billingCity"], message:"Billing city is required." });
  if (!input.billingPostalCode) context.addIssue({ code:"custom", path:["billingPostalCode"], message:"Billing postal code is required." });
}).transform(input => ({
  companyName:input.companyName,
  countryCode:input.countryCode,
  vatNumber:input.vatNumber,
  registrationNumber:input.registrationNumber,
  phone:input.phone,
  billingAddress:input.billingAddressLine1 ? {
    addressLine1:input.billingAddressLine1,
    addressLine2:input.billingAddressLine2,
    city:input.billingCity!,
    postalCode:input.billingPostalCode!,
    region:input.billingRegion,
  } : undefined,
}));
const id = (v:string|string[]) => { const r=uuid.safeParse(v); if(!r.success) throw new AppError(400,"INVALID_ID","A valid identifier is required."); return r.data; };

export const accountsRouter=Router();
accountsRouter.get("/account/addresses",requireAuth,async(req,res)=>res.json({data:await listAddresses(req.auth!.userId)}));
accountsRouter.post("/account/addresses",requireCsrf,requireAuth,validateBody(accountAddressSchema),async(req,res)=>res.status(201).json({data:await saveAddress(req.auth!.userId,req.body)}));
accountsRouter.patch("/account/addresses/:id",requireCsrf,requireAuth,validateBody(accountAddressSchema),async(req,res)=>res.json({data:await saveAddress(req.auth!.userId,req.body,id(req.params.id))}));
accountsRouter.delete("/account/addresses/:id",requireCsrf,requireAuth,async(req,res)=>{await deleteAddress(req.auth!.userId,id(req.params.id));res.status(204).end();});
accountsRouter.get("/account/companies",requireAuth,async(req,res)=>res.json({data:await listCompanies(req.auth!.userId)}));
accountsRouter.post("/account/companies",requireCsrf,requireAuth,validateBody(accountCompanyCreateSchema),async(req,res)=>res.status(201).json({data:await createCompany(req.auth!.userId,req.body)}));
accountsRouter.put("/account/companies/active",requireCsrf,requireAuth,validateBody(z.object({companyId:uuid})),async(req,res)=>{await selectCompany(req.auth!.userId,req.body.companyId);res.json({data:{activeCompanyId:req.body.companyId}});});
accountsRouter.post("/account/companies/:id/select",requireCsrf,requireAuth,async(req,res)=>{const companyId=id(req.params.id);await selectCompany(req.auth!.userId,companyId);res.json({data:{activeCompanyId:companyId}});});
accountsRouter.get("/account/companies/:id",requireAuth,async(req,res)=>res.json({data:await companyDetail(req.auth!.userId,id(req.params.id))}));
accountsRouter.get("/account/companies/:id/members",requireAuth,async(req,res)=>res.json({data:(await companyDetail(req.auth!.userId,id(req.params.id))).members}));
accountsRouter.patch("/account/companies/:id",requireCsrf,requireAuth,validateBody(company),async(req,res)=>res.json({data:await updateCompany(req.auth!.userId,id(req.params.id),req.body)}));
accountsRouter.post("/account/companies/:id/invitations",requireCsrf,requireAuth,validateBody(z.object({email:z.string().trim().email().max(320).transform(x=>x.toLowerCase()),role:z.enum(["admin","buyer","viewer"])})),async(req,res)=>{const companyId=id(req.params.id);const result=await invite(req.auth!.userId,companyId,req.body.email,req.body.role);res.status(201).json({data:{id:result.id,email:result.email,role:result.role,expiresAt:result.expiresAt,invitationStatus:result.invitationStatus,emailStatus:result.emailStatus}});});
accountsRouter.get("/account/companies/:id/invitations",requireAuth,async(req,res)=>res.json({data:await listInvitations(req.auth!.userId,id(req.params.id))}));
accountsRouter.post("/account/companies/:id/invitations/:invitationId/resend",requireCsrf,requireAuth,validateBody(z.object({idempotencyKey:uuid})),async(req,res)=>res.json({data:await resendInvitation(req.auth!.userId,id(req.params.id),id(req.params.invitationId),req.body.idempotencyKey)}));
accountsRouter.delete("/account/companies/:id/invitations/:invitationId",requireCsrf,requireAuth,async(req,res)=>{await revokeInvitation(req.auth!.userId,id(req.params.id),id(req.params.invitationId));res.status(204).end();});
accountsRouter.post("/account/invitations/accept",requireCsrf,requireAuth,validateBody(z.object({token:z.string().min(32).max(256)})),async(req,res)=>res.json({data:{companyId:await acceptInvite(req.auth!.userId,req.body.token)}}));
accountsRouter.patch("/account/companies/:id/members/:memberId",requireCsrf,requireAuth,validateBody(z.object({role:z.enum(["owner","admin","buyer","viewer"]).optional(),status:z.enum(["active","suspended"]).optional(),remove:z.boolean().optional()}).refine(x=>x.role||x.status||x.remove,{message:"A member change is required."})),async(req,res)=>{await changeMember(req.auth!.userId,id(req.params.id),id(req.params.memberId),req.body);res.status(204).end();});
accountsRouter.delete("/account/companies/:id/members/:memberId",requireCsrf,requireAuth,async(req,res)=>{await changeMember(req.auth!.userId,id(req.params.id),id(req.params.memberId),{remove:true});res.status(204).end();});
accountsRouter.post("/account/orders/:id/claim",requireCsrf,requireAuth,validateBody(z.object({accessToken:z.string().min(32).max(256)})),async(req,res)=>{const guest=getCookie(req,GUEST_CART_COOKIE);if(!guest)throw new AppError(404,"ORDER_NOT_FOUND","The order was not found.");await claimGuestOrder(req.auth!.userId,id(req.params.id),guest,req.body.accessToken);res.json({data:{claimed:true}});});

accountsRouter.get("/admin/customers",requireAdmin,requirePermission("customers.view"),async(req,res)=>{const search=typeof req.query.search==="string"?`%${req.query.search.trim()}%`:"%%";const rows=await getDatabasePool().query(`SELECT u.id,u.email,u.first_name AS "firstName",u.last_name AS "lastName",u.status,u.account_type AS "accountType",u.created_at AS "createdAt" FROM users u WHERE NOT EXISTS (SELECT 1 FROM admin_user_roles ur WHERE ur.user_id=u.id) AND (u.email ILIKE $1 OR u.first_name ILIKE $1 OR u.last_name ILIKE $1) LIMIT 100`,[search]);res.json({data:{items:rows.rows}});});
accountsRouter.get("/admin/companies",requireAdmin,requirePermission("companies.view"),async(req,res)=>{const search=typeof req.query.search==="string"?`%${req.query.search.trim()}%`:"%%";const rows=await getDatabase().select().from(companies).where(or(ilike(companies.companyName,search),ilike(companies.vatNumber,search))).limit(100);res.json({data:{items:rows}});});
accountsRouter.get("/admin/customers/:id",requireAdmin,requirePermission("customers.view"),async(req,res)=>{const row=(await getDatabasePool().query(`SELECT u.id,u.email,u.first_name AS "firstName",u.last_name AS "lastName",u.phone,u.status,u.account_type AS "accountType",u.active_company_id AS "activeCompanyId",u.created_at AS "createdAt" FROM users u WHERE u.id=$1 AND NOT EXISTS (SELECT 1 FROM admin_user_roles ur WHERE ur.user_id=u.id)`,[id(req.params.id)])).rows[0];if(!row)throw new AppError(404,"CUSTOMER_NOT_FOUND","The customer was not found.");res.json({data:row});});
accountsRouter.get("/admin/companies/:id",requireAdmin,requirePermission("companies.view"),async(req,res)=>{const row=(await getDatabase().select().from(companies).where(eq(companies.id,id(req.params.id))).limit(1))[0];if(!row)throw new AppError(404,"COMPANY_NOT_FOUND","The company was not found.");res.json({data:row});});
accountsRouter.patch("/admin/customers/:id/status",requireCsrf,requireAdmin,requirePermission("customers.manage"),validateBody(z.object({status:z.enum(["pending","active","suspended","deactivated"])})),async(req,res)=>{const userId=id(req.params.id);const db=getDatabase();const staffCheck=await getDatabasePool().query("SELECT 1 FROM admin_user_roles WHERE user_id=$1",[userId]);if(staffCheck.rowCount)throw new AppError(404,"CUSTOMER_NOT_FOUND","The customer was not found.");const old=(await db.select({status:users.status}).from(users).where(eq(users.id,userId)).limit(1))[0];if(!old)throw new AppError(404,"CUSTOMER_NOT_FOUND","The customer was not found.");await db.transaction(async tx=>{await tx.update(users).set({status:req.body.status,updatedAt:new Date()}).where(eq(users.id,userId));await tx.insert(auditLogs).values({actorAdminId:req.auth!.userId,action:"admin.customer_status_updated",entityType:"user",entityId:userId,oldValuesJson:{status:old.status},newValuesJson:{status:req.body.status}});});res.json({data:{id:userId,status:req.body.status}});});
accountsRouter.patch("/admin/companies/:id/status",requireCsrf,requireAdmin,requirePermission("companies.manage"),validateBody(z.object({status:z.enum(["pending","active","suspended","deactivated"])})),async(req,res)=>{const companyId=id(req.params.id);const db=getDatabase();const old=(await db.select({status:companies.status}).from(companies).where(eq(companies.id,companyId)).limit(1))[0];if(!old)throw new AppError(404,"COMPANY_NOT_FOUND","The company was not found.");await db.transaction(async tx=>{await tx.update(companies).set({status:req.body.status,updatedAt:new Date()}).where(eq(companies.id,companyId));await tx.insert(auditLogs).values({actorAdminId:req.auth!.userId,action:"admin.company_status_updated",entityType:"company",entityId:companyId,oldValuesJson:{status:old.status},newValuesJson:{status:req.body.status}});});res.json({data:{id:companyId,status:req.body.status}});});