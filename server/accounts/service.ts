import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { addDays, createOpaqueToken, hashOpaqueToken } from "../auth/tokens.js";
import { emitNotification } from "../notifications/service.js";

export type CompanyRole = "owner" | "admin" | "buyer" | "viewer";

const roles: CompanyRole[] = ["owner", "admin", "buyer", "viewer"];
export function asRole(value: string): CompanyRole {
  if (!roles.includes(value as CompanyRole)) throw new AppError(400, "INVALID_COMPANY_ROLE", "An invalid company role was provided.");
  return value as CompanyRole;
}
export async function membership(userId: string, companyId: string, write = false) {
  const row = (await getDatabasePool().query(
    `SELECT cu.role, cu.status, c.status AS "companyStatus" FROM company_users cu JOIN companies c ON c.id=cu.company_id
      WHERE cu.user_id=$1 AND cu.company_id=$2`, [userId, companyId],
  )).rows[0];
  if (!row || row.status !== "active" || row.companyStatus !== "active") throw new AppError(403, "COMPANY_ACCESS_DENIED", "You do not have access to this company.");
  if (write && !["owner", "admin"].includes(row.role)) throw new AppError(403, "COMPANY_ROLE_REQUIRED", "Company administrator access is required.");
  return row as { role: CompanyRole; status: string; companyStatus: string };
}
async function audit(client: any, actor: string | null, action: string, entityType: string, entityId: string | null, before?: unknown, after?: unknown) {
  await client.query("INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES ($1,$2,$3,$4,$5,$6)",
    [actor, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}
export async function listAddresses(userId: string) {
  return (await getDatabasePool().query(`SELECT id,type,first_name AS "firstName",last_name AS "lastName",company_name AS "companyName",address_line_1 AS "addressLine1",address_line_2 AS "addressLine2",city,postal_code AS "postalCode",region,country_code AS "countryCode",phone,is_default AS "isDefault" FROM addresses WHERE user_id=$1 ORDER BY is_default DESC,created_at DESC`, [userId])).rows;
}
export async function saveAddress(userId: string, input: any, addressId?: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    let before: any = null;
    if (addressId) {
      before = (await client.query("SELECT * FROM addresses WHERE id=$1 AND user_id=$2 FOR UPDATE", [addressId, userId])).rows[0];
      if (!before) throw new AppError(404, "ADDRESS_NOT_FOUND", "The address was not found.");
    }
    if (input.isDefault) await client.query("UPDATE addresses SET is_default=false,updated_at=now() WHERE user_id=$1 AND type=$2", [userId, input.type]);
    const values = [input.type, input.firstName, input.lastName, input.companyName ?? null, input.addressLine1, input.addressLine2 ?? null, input.city, input.postalCode, input.region ?? null, input.countryCode, input.phone ?? null, Boolean(input.isDefault)];
    const row = addressId
      ? (await client.query(`UPDATE addresses SET type=$1,first_name=$2,last_name=$3,company_name=$4,address_line_1=$5,address_line_2=$6,city=$7,postal_code=$8,region=$9,country_code=$10,phone=$11,is_default=$12,updated_at=now() WHERE id=$13 RETURNING *`, [...values, addressId])).rows[0]
      : (await client.query(`INSERT INTO addresses (user_id,type,first_name,last_name,company_name,address_line_1,address_line_2,city,postal_code,region,country_code,phone,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [userId, ...values])).rows[0];
    await audit(client, userId, addressId ? "address.updated" : "address.created", "address", row.id, before, row);
    await client.query("COMMIT"); return row;
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
export async function deleteAddress(userId: string, addressId: string) {
  const client = await getDatabasePool().connect();
  try { await client.query("BEGIN"); const old = (await client.query("DELETE FROM addresses WHERE id=$1 AND user_id=$2 RETURNING *", [addressId, userId])).rows[0]; if (!old) throw new AppError(404, "ADDRESS_NOT_FOUND", "The address was not found."); await audit(client, userId, "address.deleted", "address", addressId, old); await client.query("COMMIT"); } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
export async function listCompanies(userId: string) {
  return (await getDatabasePool().query(`SELECT c.id,c.company_name AS "companyName",c.vat_number AS "vatNumber",c.status,cu.role,cu.status AS "membershipStatus",(u.active_company_id=c.id) AS "active" FROM company_users cu JOIN companies c ON c.id=cu.company_id JOIN users u ON u.id=cu.user_id WHERE cu.user_id=$1 ORDER BY c.company_name`, [userId])).rows;
}
export async function createCompany(userId: string, input: any) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const owner = (await client.query("SELECT first_name,last_name,email FROM users WHERE id=$1 AND status='active' FOR UPDATE", [userId])).rows[0];
    if (!owner) throw new AppError(403, "ACCOUNT_INACTIVE", "Your account cannot create a company.");
    const contactPerson = `${owner.first_name} ${owner.last_name}`.trim();
    const company = (await client.query(
      `INSERT INTO companies (company_name,vat_number,registration_number,contact_person,phone,email,country_code,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING id,company_name AS "companyName",status`,
      [input.companyName, input.vatNumber ?? null, input.registrationNumber ?? null, contactPerson, input.phone ?? null, owner.email, input.countryCode],
    )).rows[0];
    if (!company) throw new Error("Company creation failed.");
    await client.query("INSERT INTO company_users (company_id,user_id,company_role,role,status) VALUES ($1,$2,'owner','owner','active')", [company.id, userId]);
    if (input.billingAddress) {
      const billing = input.billingAddress;
      const address = (await client.query(
        `INSERT INTO addresses (company_id,type,first_name,last_name,company_name,address_line_1,address_line_2,city,postal_code,region,country_code,is_default)
         VALUES ($1,'billing',$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING id`,
        [company.id, owner.first_name, owner.last_name, input.companyName, billing.addressLine1, billing.addressLine2 ?? null, billing.city, billing.postalCode, billing.region ?? null, input.countryCode],
      )).rows[0];
      await client.query("UPDATE companies SET billing_address_id=$1 WHERE id=$2", [address.id, company.id]);
    }
    await client.query("UPDATE users SET active_company_id=$1,account_type='business',updated_at=now() WHERE id=$2", [company.id, userId]);
    await audit(client, userId, "company.created", "company", company.id, undefined, { companyName: company.companyName, status: company.status, role: "owner" });
    await client.query("COMMIT");
    return { ...company, role: "owner", membershipStatus: "active", active: true };
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") throw new AppError(409, "COMPANY_CONFLICT", "That VAT number is already registered.");
    throw error;
  } finally {
    client.release();
  }
}
export async function selectCompany(userId: string, companyId: string) {
  await membership(userId, companyId);
  await getDatabasePool().query("UPDATE users SET active_company_id=$1,updated_at=now() WHERE id=$2", [companyId, userId]);
}
export async function companyDetail(userId: string, companyId: string) {
  const currentMembership = await membership(userId, companyId);
  const pool = getDatabasePool();
  const company = (await pool.query(`SELECT id,company_name AS "companyName",vat_number AS "vatNumber",registration_number AS "registrationNumber",contact_person AS "contactPerson",phone,email,country_code AS "countryCode",status FROM companies WHERE id=$1`, [companyId])).rows[0];
  const members = (await pool.query(`SELECT u.id,u.email,u.first_name AS "firstName",u.last_name AS "lastName",cu.role,cu.status,cu.created_at AS "createdAt" FROM company_users cu JOIN users u ON u.id=cu.user_id WHERE cu.company_id=$1 ORDER BY cu.created_at`, [companyId])).rows;
  return { ...company, currentMemberRole: currentMembership.role, members };
}
export async function updateCompany(userId: string, companyId: string, input: any) {
  await membership(userId, companyId, true); const client = await getDatabasePool().connect();
  try { await client.query("BEGIN"); const before = (await client.query("SELECT * FROM companies WHERE id=$1 FOR UPDATE", [companyId])).rows[0]; const row = (await client.query(`UPDATE companies SET company_name=$1,registration_number=$2,contact_person=$3,phone=$4,email=$5,country_code=$6,updated_at=now() WHERE id=$7 RETURNING *`, [input.companyName, input.registrationNumber ?? null, input.contactPerson, input.phone ?? null, input.email, input.countryCode ?? null, companyId])).rows[0]; await audit(client,userId,"company.updated","company",companyId,before,row); await client.query("COMMIT"); return row; } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
export async function invite(userId: string, companyId: string, email: string, role: CompanyRole) {
  const actor = await membership(userId, companyId, true);
  // Administrators retain normal invitation authority, but privilege grant is
  // reserved to an owner. Invitations never create owners themselves.
  if (role === "admin" && actor.role !== "owner") throw new AppError(403, "OWNER_REQUIRED", "Only an owner may invite a company administrator.");
  const token = createOpaqueToken(); const client = await getDatabasePool().connect();
  try { await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('company-invitation:' || $1 || ':' || lower($2)))",[companyId,email]);
    if((await client.query("SELECT 1 FROM company_users cu JOIN users u ON u.id=cu.user_id WHERE cu.company_id=$1 AND cu.status='active' AND lower(u.email)=lower($2)",[companyId,email])).rowCount) throw new AppError(409,"ACTIVE_COMPANY_MEMBER","That email already belongs to an active company member.");
    if((await client.query("SELECT 1 FROM company_invitations WHERE company_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()",[companyId,email])).rowCount) throw new AppError(409,"INVITATION_PENDING","A valid pending invitation already exists for that email.");
    const row=(await client.query("INSERT INTO company_invitations (company_id,email,role,token_hash,invited_by_user_id,expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,email,role,expires_at AS \"expiresAt\"",[companyId,email,role,hashOpaqueToken(token),userId,addDays(7)])).rows[0]; await audit(client,userId,"company.invitation_created","company_invitation",row.id,undefined,{email,role}); await emitNotification({type:"company.invitation",idempotencyKey:`company-invitation:${row.id}`,email,message:"Use the secure link in this email to accept your Lizzor company invitation.",secureToken:token,metadata:{companyId,invitationId:row.id}},client);
    const emailStatus=await invitationEmailStatus(client,row.id); if(!emailStatus) throw new Error("Invitation email outbox row was not created.");
    await client.query("COMMIT"); return { ...row, token, invitationStatus:"pending", emailStatus }; } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
export async function acceptInvite(userId: string, token: string) {
  const client=await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const invitation=(await client.query(`SELECT * FROM company_invitations WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`,[hashOpaqueToken(token)])).rows[0];
    if(!invitation) throw new AppError(400,"INVALID_INVITATION","The invitation is invalid or expired.");
    const company=(await client.query("SELECT status FROM companies WHERE id=$1 FOR UPDATE",[invitation.company_id])).rows[0];
    if(!company || company.status!=="active") throw new AppError(409,"COMPANY_INACTIVE","This company cannot accept invitations.");
    const user=(await client.query("SELECT email FROM users WHERE id=$1 FOR UPDATE",[userId])).rows[0];
    if(!user || user.email.toLowerCase()!==invitation.email.toLowerCase()) throw new AppError(403,"INVITATION_EMAIL_MISMATCH","Sign in with the invited email address.");
    if((await client.query("SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2 AND status='active'",[invitation.company_id,userId])).rowCount) throw new AppError(409,"ACTIVE_COMPANY_MEMBER","You are already an active company member.");
    await client.query("INSERT INTO company_users (company_id,user_id,role,status) VALUES ($1,$2,$3,'active') ON CONFLICT (company_id,user_id) DO UPDATE SET role=EXCLUDED.role,status='active'",[invitation.company_id,userId,invitation.role]);
    const accepted=await client.query("UPDATE company_invitations SET accepted_at=now() WHERE id=$1 AND accepted_at IS NULL",[invitation.id]);
    if(!accepted.rowCount) throw new AppError(400,"INVALID_INVITATION","The invitation is no longer available.");
    await client.query("UPDATE users SET active_company_id=COALESCE(active_company_id,$1) WHERE id=$2",[invitation.company_id,userId]);
    await audit(client,userId,"company.invitation_accepted","company_invitation",invitation.id,undefined,{companyId:invitation.company_id});
    await client.query("COMMIT"); return invitation.company_id;
  } catch(e){await client.query("ROLLBACK");throw e;} finally{client.release();} 
}
export async function listInvitations(userId:string, companyId:string) {
  await membership(userId,companyId,true);
  return (await getDatabasePool().query(`SELECT i.id,i.email,i.role,i.expires_at AS "expiresAt",i.accepted_at AS "acceptedAt",i.revoked_at AS "revokedAt",i.created_at AS "createdAt",concat_ws(' ',u.first_name,u.last_name) AS "invitedByName",u.email AS "invitedByEmail",CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.revoked_at IS NOT NULL THEN 'cancelled' WHEN i.expires_at<=now() THEN 'expired' ELSE 'pending' END AS "invitationStatus",d."emailStatus" FROM company_invitations i JOIN users u ON u.id=i.invited_by_user_id LEFT JOIN LATERAL (SELECT CASE WHEN provider_status IN ('delivered','bounced','complained','failed') THEN provider_status WHEN provider_status='delivery_delayed' THEN 'delayed' WHEN status='sent' THEN 'sent' WHEN status='failed' THEN 'failed' WHEN status='processing' THEN 'sending' WHEN status='pending' THEN 'queued' WHEN status='cancelled' THEN 'cancelled' END AS "emailStatus" FROM notification_deliveries WHERE event_type='company.invitation' AND metadata_json->>'invitationId'=i.id::text ORDER BY created_at DESC LIMIT 1) d ON true WHERE i.company_id=$1 ORDER BY i.created_at DESC`,[companyId])).rows;
}
async function invitationEmailStatus(client:any, invitationId:string) { return (await client.query(`SELECT CASE WHEN provider_status IN ('delivered','bounced','complained','failed') THEN provider_status WHEN provider_status='delivery_delayed' THEN 'delayed' WHEN status='sent' THEN 'sent' WHEN status='failed' THEN 'failed' WHEN status='processing' THEN 'sending' WHEN status='pending' THEN 'queued' WHEN status='cancelled' THEN 'cancelled' END AS "emailStatus" FROM notification_deliveries WHERE event_type='company.invitation' AND metadata_json->>'invitationId'=$1 ORDER BY created_at DESC LIMIT 1`,[invitationId])).rows[0]?.emailStatus; }
export async function resendInvitation(userId:string,companyId:string,invitationId:string,idempotencyKey:string) {
  const actor=await membership(userId,companyId,true), client=await getDatabasePool().connect();
  try { await client.query("BEGIN"); const i=(await client.query("SELECT * FROM company_invitations WHERE id=$1 AND company_id=$2 FOR UPDATE",[invitationId,companyId])).rows[0]; if(!i) throw new AppError(404,"INVITATION_NOT_FOUND","The invitation was not found."); if(actor.role!=="owner"&&i.role==="admin") throw new AppError(403,"OWNER_REQUIRED","Only an owner may resend an administrator invitation."); if(i.accepted_at) throw new AppError(409,"INVITATION_ACCEPTED","The invitation has already been accepted."); if(i.revoked_at) throw new AppError(409,"INVITATION_CANCELLED","The invitation has been cancelled."); if((await client.query("SELECT 1 FROM company_users cu JOIN users u ON u.id=cu.user_id WHERE cu.company_id=$1 AND cu.status='active' AND lower(u.email)=lower($2)",[companyId,i.email])).rowCount) throw new AppError(409,"ACTIVE_COMPANY_MEMBER","That email already belongs to an active company member.");
    if(i.last_resend_idempotency_key===idempotencyKey) { const emailStatus=await invitationEmailStatus(client,invitationId); if(!emailStatus) throw new Error("Invitation email outbox row was not created."); await client.query("COMMIT"); return {id:i.id,email:i.email,role:i.role,expiresAt:i.expires_at,invitationStatus:"pending",emailStatus}; }
    await client.query("UPDATE notification_deliveries SET status='cancelled',encrypted_secret=NULL,locked_at=NULL,lock_token=NULL,updated_at=now() WHERE event_type='company.invitation' AND metadata_json->>'invitationId'=$1 AND status IN ('pending','failed','processing')",[invitationId]);
    const token=createOpaqueToken(), row=(await client.query("UPDATE company_invitations SET token_hash=$1,expires_at=$2,last_resend_idempotency_key=$3 WHERE id=$4 RETURNING id,email,role,expires_at AS \"expiresAt\"",[hashOpaqueToken(token),addDays(7),idempotencyKey,invitationId])).rows[0]; await emitNotification({type:"company.invitation",idempotencyKey:`company-invitation:${invitationId}:resend:${idempotencyKey}`,email:row.email,message:"Use the secure link in this email to accept your Lizzor company invitation.",secureToken:token,metadata:{companyId,invitationId}},client); const emailStatus=await invitationEmailStatus(client,invitationId); if(!emailStatus) throw new Error("Invitation email outbox row was not created."); await audit(client,userId,"company.invitation_resent","company_invitation",invitationId); await client.query("COMMIT"); return {...row,invitationStatus:"pending",emailStatus};
  } catch(e){await client.query("ROLLBACK");throw e;} finally{client.release();}
}
export async function revokeInvitation(userId:string,companyId:string,invitationId:string) {
  await membership(userId,companyId,true); const client=await getDatabasePool().connect();
  try {await client.query("BEGIN");const old=(await client.query("UPDATE company_invitations SET revoked_at=now() WHERE id=$1 AND company_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id,email,role",[invitationId,companyId])).rows[0];if(!old)throw new AppError(404,"INVITATION_NOT_FOUND","The invitation was not found.");await client.query("UPDATE notification_deliveries SET status='cancelled',encrypted_secret=NULL,locked_at=NULL,lock_token=NULL,updated_at=now() WHERE event_type='company.invitation' AND metadata_json->>'invitationId'=$1 AND status IN ('pending','failed','processing')",[invitationId]);await audit(client,userId,"company.invitation_revoked","company_invitation",invitationId,{email:old.email,role:old.role});await client.query("COMMIT");}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}
export async function changeMember(userId:string, companyId:string, memberId:string, patch:{role?:CompanyRole;status?:"active"|"suspended";remove?:boolean}) {
  const client=await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    // This lock serializes all owner-count decisions, including self changes.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('company:' || $1))", [companyId]);
    const actor=(await client.query(`SELECT cu.role FROM company_users cu JOIN companies c ON c.id=cu.company_id WHERE cu.company_id=$1 AND cu.user_id=$2 AND cu.status='active' AND c.status='active' FOR UPDATE`,[companyId,userId])).rows[0];
    if(!actor || !["owner","admin"].includes(actor.role)) throw new AppError(403,"COMPANY_ROLE_REQUIRED","Company administrator access is required.");
    const target=(await client.query("SELECT * FROM company_users WHERE company_id=$1 AND user_id=$2 FOR UPDATE",[companyId,memberId])).rows[0];
    if(!target) throw new AppError(404,"MEMBER_NOT_FOUND","The member was not found.");
    const ownerSensitive=target.role==="owner" || patch.role==="owner";
    if(ownerSensitive && actor.role!=="owner") throw new AppError(403,"OWNER_REQUIRED","Only an owner may manage owner access.");
    if(patch.role==="admin" && actor.role!=="owner") throw new AppError(403,"OWNER_REQUIRED","Only an owner may grant company administrator access.");
    const removesActiveOwner=target.role==="owner" && target.status==="active" && (patch.remove || patch.role!=="owner" || patch.status==="suspended");
    if(removesActiveOwner) { const owners=(await client.query("SELECT count(*)::int AS count FROM company_users WHERE company_id=$1 AND role='owner' AND status='active'",[companyId])).rows[0]; if(owners.count<2) throw new AppError(409,"LAST_OWNER","A company must retain at least one active owner."); }
    if(patch.remove) await client.query("DELETE FROM company_users WHERE company_id=$1 AND user_id=$2",[companyId,memberId]);
    else await client.query("UPDATE company_users SET role=COALESCE($1,role),status=COALESCE($2,status) WHERE company_id=$3 AND user_id=$4",[patch.role??null,patch.status??null,companyId,memberId]);
    await audit(client,userId,patch.remove?"company.member_removed":"company.member_updated","company_member",memberId,{role:target.role,status:target.status},{role:patch.role,status:patch.status,removed:Boolean(patch.remove)});
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}
export async function claimGuestOrder(userId:string, orderId:string, guestSessionId:string, token:string) {
  const client=await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const row=(await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE",[orderId])).rows[0];
    if(!row||row.user_id||row.guest_session_id!==guestSessionId||row.guest_access_token_hash!==hashOpaqueToken(token))throw new AppError(404,"ORDER_NOT_FOUND","The order was not found.");
    await client.query("INSERT INTO guest_order_claims (order_id,claimed_by_user_id,guest_session_id,guest_access_token_hash) VALUES ($1,$2,$3,$4)",[orderId,userId,guestSessionId,row.guest_access_token_hash]);
    await client.query("UPDATE orders SET user_id=$1,updated_at=now() WHERE id=$2",[userId,orderId]);
    await audit(client,userId,"order.guest_claimed","order",orderId,undefined,{claimed:true});
    await emitNotification({type:"account.guest_order_claimed",idempotencyKey:`guest-order-claimed:${orderId}:${userId}`,userId,message:`Order ${row.order_number} is now available in your account.`,metadata:{orderId,orderNumber:row.order_number,path:`/account/orders/${orderId}`}},client);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}