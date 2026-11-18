import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailService } from "../auth/email.js";
import { runNotificationDeliveryWorker } from "../notifications/service.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { acceptInvite, changeMember, claimGuestOrder, companyDetail, createCompany, deleteAddress, invite, listAddresses, listCompanies, listInvitations, resendInvitation, revokeInvitation, saveAddress, selectCompany, updateCompany } from "./service.js";
import { accountAddressSchema, accountCompanyCreateSchema } from "../api/accounts.js";
import { getOrder, listCustomerOrders } from "../orders/service.js";
import { createOpaqueToken, hashOpaqueToken } from "../auth/tokens.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const mark = `accounts-${suffix}`;
const address = { type: "shipping" as const, firstName: "Test", lastName: "Person", addressLine1: "1 Main", city: "Nicosia", postalCode: "1000", countryCode: "CY", isDefault: true };
let userIds: string[] = [], companyIds: string[] = [], orderIds: string[] = [];

class CapturingProvider implements EmailService {
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.messages.push(message);
    return { providerMessageId: `company-invite-${this.messages.length}` };
  }
}

async function user(pool: ReturnType<typeof getDatabasePool>, name: string) {
  const row = (await pool.query(`INSERT INTO users (email,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'User','active',now()) RETURNING id`, [`${mark}-${name}@example.test`, name])).rows[0];
  userIds.push(row.id); return row.id as string;
}
async function company(pool: ReturnType<typeof getDatabasePool>, name: string) {
  const row = (await pool.query(`INSERT INTO companies (company_name,vat_number,contact_person,email,status) VALUES ($1,$2,'Contact',$3,'active') RETURNING id`, [`${mark}-${name}`, `${mark}-${name}`, `${mark}-${name}@company.test`])).rows[0];
  companyIds.push(row.id); return row.id as string;
}
async function order(pool: ReturnType<typeof getDatabasePool>, owner: string | null, companyId: string | null, guest?: { session: string; token: string }) {
  const row = (await pool.query(`INSERT INTO orders (order_number,user_id,company_id,guest_email,guest_session_id,guest_access_token_hash,status,payment_status,fulfillment_status,fulfillment_stage,currency,subtotal,discount_total,shipping_total,tax_total,grand_total,billing_address_snapshot,shipping_address_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,'pending','pending','unfulfilled','unfulfilled','EUR',1,0,0,0,1,'{}','{}') RETURNING id`,
    [`${mark}-${orderIds.length}`, owner, companyId, guest ? `${mark}@guest.test` : null, guest?.session ?? null, guest ? hashOpaqueToken(guest.token) : null])).rows[0];
  orderIds.push(row.id); return row.id as string;
}

async function run() {
  const pool = getDatabasePool();
  try {
    const owner = await user(pool, "owner"), admin = await user(pool, "admin"), buyer = await user(pool, "buyer"), viewer = await user(pool, "viewer"), outsider = await user(pool, "outsider");
    const tenant = await company(pool, "tenant"), otherTenant = await company(pool, "other");
    await pool.query(`INSERT INTO company_users (company_id,user_id,role,status) VALUES ($1,$2,'owner','active'),($1,$3,'admin','active'),($1,$4,'buyer','active'),($1,$5,'viewer','active'),($6,$2,'owner','active')`, [tenant, owner, admin, buyer, viewer, otherTenant]);

    // Detail resolves the authenticated membership for the requested company, never a fallback role.
    assert.equal((await companyDetail(owner, tenant)).currentMemberRole, "owner");
    assert.equal((await companyDetail(admin, tenant)).currentMemberRole, "admin");
    assert.equal((await companyDetail(buyer, tenant)).currentMemberRole, "buyer");
    assert.equal((await companyDetail(viewer, tenant)).currentMemberRole, "viewer");
    assert.equal((await companyDetail(owner, otherTenant)).currentMemberRole, "owner");
    await assert.rejects(() => companyDetail(buyer, otherTenant), /access/i);
    const switchingUser = await user(pool, "switching");
    await pool.query("INSERT INTO company_users (company_id,user_id,role,status) VALUES ($1,$3,'viewer','active'),($2,$3,'buyer','active')", [tenant, otherTenant, switchingUser]);
    await selectCompany(switchingUser, tenant);
    assert.equal((await companyDetail(switchingUser, tenant)).currentMemberRole, "viewer");
    assert.equal((await companyDetail(switchingUser, otherTenant)).currentMemberRole, "buyer");
    await selectCompany(switchingUser, otherTenant);
    assert.equal((await companyDetail(switchingUser, tenant)).currentMemberRole, "viewer");
    assert.equal((await companyDetail(switchingUser, otherTenant)).currentMemberRole, "buyer");
    const companyUpdate = { companyName: `${mark}-tenant`, registrationNumber: null, contactPerson: "Contact", phone: null, email: `${mark}-tenant@company.test`, countryCode: "CY" };
    await updateCompany(owner, tenant, companyUpdate);
    await updateCompany(admin, tenant, companyUpdate);
    await assert.rejects(() => updateCompany(buyer, tenant, companyUpdate), /administrator access/i);
    await assert.rejects(() => updateCompany(viewer, tenant, companyUpdate), /administrator access/i);

    // Address rows are user-scoped and changing a default clears the previous default.
    const first = await saveAddress(owner, address);
    const second = await saveAddress(owner, { ...address, addressLine1: "2 Main", isDefault: true });
    const billing = await saveAddress(owner, { ...address, type: "billing", companyName: "Optional Company", phone: null, isDefault: false });
    const edited = await saveAddress(owner, { ...address, type: "billing", addressLine1: "3 Updated", phone: null, isDefault: false }, billing.id);
    assert.equal(edited.address_line_1, "3 Updated");
    assert.equal((await listAddresses(owner)).filter((x: any) => x.isDefault).length, 1);
    assert.equal((await listAddresses(outsider)).length, 0);
    await assert.rejects(() => saveAddress(outsider, address, first.id), /not found/i);
    await assert.rejects(() => deleteAddress(outsider, billing.id), /not found/i);
    await deleteAddress(owner, billing.id);
    assert.equal((await listAddresses(owner)).some((x: any) => x.id === billing.id), false);
    assert.equal(accountAddressSchema.safeParse({ ...address, phone: "" }).success, true);
    assert.equal(accountAddressSchema.safeParse({ ...address, countryCode: "US", phone: null }).success, true);
    const missingAddress = accountAddressSchema.safeParse({ type: "shipping", countryCode: "CY" });
    assert.equal(missingAddress.success, false);
    if (!missingAddress.success) assert.ok(missingAddress.error.flatten().fieldErrors.addressLine1?.[0]);
    assert.ok(second.id);

    // Account company creation atomically activates the company and owner membership.
    const createdCompany = await createCompany(outsider, { companyName: `${mark}-created`, countryCode: "CY", phone: null, billingAddress: { addressLine1: "4 Business", city: "Nicosia", postalCode: "1001" } });
    companyIds.push(createdCompany.id);
    assert.equal(createdCompany.role, "owner");
    const createdAccess = (await listCompanies(outsider)).find((item: any) => item.id === createdCompany.id);
    assert.equal(createdAccess.active, true);
    assert.equal(createdAccess.membershipStatus, "active");
    const createdOwner = (await pool.query("SELECT role,status FROM company_users WHERE company_id=$1 AND user_id=$2", [createdCompany.id, outsider])).rows[0];
    assert.deepEqual(createdOwner, { role: "owner", status: "active" });
    const createdBilling = (await pool.query("SELECT a.phone,a.type FROM companies c JOIN addresses a ON a.id=c.billing_address_id WHERE c.id=$1", [createdCompany.id])).rows[0];
    assert.deepEqual(createdBilling, { phone: null, type: "billing" });
    assert.equal(accountCompanyCreateSchema.safeParse({ companyName: "", countryCode: "CY" }).success, false);
    const partialBilling = accountCompanyCreateSchema.safeParse({ companyName: "Partial Billing", countryCode: "CY", billingAddressLine1: "5 Incomplete" });
    assert.equal(partialBilling.success, false);
    if (!partialBilling.success) {
      const billingErrors = partialBilling.error.flatten().fieldErrors as Record<string, string[] | undefined>;
      assert.ok(billingErrors.billingCity?.[0]);
      assert.ok(billingErrors.billingPostalCode?.[0]);
    }

    // Selection must be an active membership and is tenant-isolated.
    await pool.query("UPDATE users SET active_company_id=$1 WHERE id=$2", [tenant, owner]);
    assert.equal((await listCompanies(owner)).find((x: any) => x.id === tenant).active, true);
    await assert.rejects(() => changeMember(admin, tenant, buyer, { role: "owner" }), /owner/i);
    await assert.rejects(() => changeMember(admin, tenant, buyer, { role: "admin" }), /only an owner/i);
    await changeMember(owner, tenant, buyer, { role: "admin" });
    await changeMember(owner, tenant, buyer, { role: "buyer" });
    await changeMember(owner, tenant, admin, { role: "owner" });
    await changeMember(owner, tenant, admin, { role: "admin" });

    // Advisory lock + owner count means both concurrent self-demotions cannot win.
    const demotions = await Promise.allSettled([
      changeMember(owner, tenant, owner, { role: "admin" }),
      changeMember(admin, tenant, admin, { role: "buyer" }),
    ]);
    assert.ok(demotions.some((r) => r.status === "rejected"));
    const activeOwners = (await pool.query("SELECT count(*)::int AS n FROM company_users WHERE company_id=$1 AND role='owner' AND status='active'", [tenant])).rows[0].n;
    assert.ok(activeOwners >= 1);
    // Restore the roles used by the independent order-scope assertions.
    await pool.query("UPDATE company_users SET role='owner',status='active' WHERE company_id=$1 AND user_id=$2", [tenant, owner]);
    await pool.query("UPDATE company_users SET role='admin',status='active' WHERE company_id=$1 AND user_id=$2", [tenant, admin]);

    // Invitations are tenant-scoped, durable outbox events, and atomically single-use.
    const invited = await user(pool, "invited");
    const pendingEmail = `${mark}-pending@example.test`;
    // Owners may grant buyer/admin; admins may only grant non-admin roles.
    const ownerBuyerInvitation = await invite(owner, tenant, pendingEmail, "buyer");
    assert.equal(ownerBuyerInvitation.invitationStatus, "pending");
    assert.equal(ownerBuyerInvitation.emailStatus, "queued");
    const initialDelivery = (await pool.query(`SELECT status FROM notification_deliveries
      WHERE event_type='company.invitation' AND metadata_json->>'invitationId'=$1`, [ownerBuyerInvitation.id])).rows[0];
    assert.equal(initialDelivery.status, "pending");
    await assert.rejects(() => invite(owner, tenant, pendingEmail, "buyer"), /pending/i);
    await assert.rejects(() => invite(owner, tenant, `${mark}-admin@example.test`, "buyer"), /active company member/i);
    await assert.rejects(() => invite(buyer, tenant, `${mark}-buyer-denied@example.test`, "buyer"), /administrator access/i);
    await assert.rejects(() => invite(viewer, tenant, `${mark}-viewer-denied@example.test`, "buyer"), /administrator access/i);

    const adminInvitation = await invite(admin, tenant, `${mark}-admin-invited@example.test`, "buyer");
    assert.equal(adminInvitation.role, "buyer");
    await assert.rejects(() => invite(admin, tenant, `${mark}-forbidden-admin@example.test`, "admin"), /only an owner/i);
    await assert.rejects(() => invite(admin, otherTenant, `${mark}-other-tenant@example.test`, "buyer"), /access/i);
    const ownerAdminInvitation = await invite(owner, tenant, `${mark}-owner-admin-invited@example.test`, "admin");
    assert.equal(ownerAdminInvitation.role, "admin");
    const listed = await listInvitations(owner, tenant);
    const listedPending = listed.find((row: any) => row.id === ownerBuyerInvitation.id);
    assert.equal(listedPending.invitationStatus, "pending");
    assert.equal(listedPending.emailStatus, "queued");
    assert.equal(listedPending.invitedByEmail, `${mark}-owner@example.test`);
    assert.equal(listedPending.invitedByName, "owner User");
    assert.ok(listedPending.createdAt);
    assert.ok(listedPending.expiresAt);
    assert.equal(Object.prototype.hasOwnProperty.call(listedPending, "token"), false);
    await assert.rejects(() => resendInvitation(owner, otherTenant, ownerBuyerInvitation.id, randomUUID()), /not found/i);
    await assert.rejects(() => revokeInvitation(owner, otherTenant, ownerBuyerInvitation.id), /not found/i);
    await assert.rejects(() => resendInvitation(admin, tenant, ownerAdminInvitation.id, randomUUID()), /only an owner/i);
    await assert.rejects(() => resendInvitation(owner, otherTenant, ownerBuyerInvitation.id, randomUUID()), /not found/i);

    // A resend rotates the token, produces one durable email for its UUID key, and retries are no-ops.
    const oldTokenHash = (await pool.query("SELECT token_hash FROM company_invitations WHERE id=$1", [ownerBuyerInvitation.id])).rows[0].token_hash;
    const resendKey = randomUUID();
    const resent = await resendInvitation(owner, tenant, ownerBuyerInvitation.id, resendKey);
    assert.equal(resent.invitationStatus, "pending");
    assert.equal(resent.emailStatus, "queued");
    const newTokenHash = (await pool.query("SELECT token_hash FROM company_invitations WHERE id=$1", [ownerBuyerInvitation.id])).rows[0].token_hash;
    assert.notEqual(newTokenHash, oldTokenHash);
    assert.equal(
      (await pool.query("SELECT status FROM notification_deliveries WHERE event_type='company.invitation' AND metadata_json->>'invitationId'=$1 ORDER BY created_at LIMIT 1", [ownerBuyerInvitation.id])).rows[0].status,
      "cancelled",
    );
    const deliveryCount = Number((await pool.query(`SELECT count(*) FROM notification_deliveries
      WHERE event_type='company.invitation' AND metadata_json->>'invitationId'=$1`, [ownerBuyerInvitation.id])).rows[0].count);
    await resendInvitation(owner, tenant, ownerBuyerInvitation.id, resendKey);
    const retryDeliveryCount = Number((await pool.query(`SELECT count(*) FROM notification_deliveries
      WHERE event_type='company.invitation' AND metadata_json->>'invitationId'=$1`, [ownerBuyerInvitation.id])).rows[0].count);
    assert.equal(retryDeliveryCount, deliveryCount);

    // Cancellation invalidates all queued invitation mail and cannot be resent.
    await revokeInvitation(owner, tenant, ownerBuyerInvitation.id);
    const cancelledDelivery = (await pool.query(`SELECT status FROM notification_deliveries
      WHERE event_type='company.invitation' AND metadata_json->>'invitationId'=$1 ORDER BY created_at DESC LIMIT 1`, [ownerBuyerInvitation.id])).rows[0];
    assert.equal(cancelledDelivery.status, "cancelled");
    const sendableCancelledDeliveries = Number((await pool.query(`SELECT count(*) FROM notification_deliveries
      WHERE event_type='company.invitation' AND metadata_json->>'invitationId'=$1 AND status IN ('pending','failed','processing')`, [ownerBuyerInvitation.id])).rows[0].count);
    assert.equal(sendableCancelledDeliveries, 0);
    await assert.rejects(() => resendInvitation(owner, tenant, ownerBuyerInvitation.id, randomUUID()), /cancelled/i);
    const invitationProvider = new CapturingProvider();
    await runNotificationDeliveryWorker(100, invitationProvider);
    assert.equal(invitationProvider.messages.some((message) => message.to === pendingEmail), false, "cancelled and superseded invitation tokens must never be sent");

    // Expiry rejects acceptance but is renewable by a resend.
    const expired = await invite(owner, tenant, `${mark}-expired@example.test`, "viewer");
    await pool.query("UPDATE company_invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    await assert.rejects(() => acceptInvite(invited, expired.token), /invalid|expired/i);
    const renewed = await resendInvitation(owner, tenant, expired.id, randomUUID());
    assert.equal(renewed.invitationStatus, "pending");

    const invitation = await invite(owner, tenant, `${mark}-invited@example.test`, "buyer");
    await assert.rejects(() => acceptInvite(outsider, invitation.token), /invited email/i);
    assert.equal(await acceptInvite(invited, invitation.token), tenant);
    assert.equal((await companyDetail(invited, tenant)).currentMemberRole, "buyer");
    await assert.rejects(() => acceptInvite(invited, invitation.token), /invalid|expired/i);
    const acceptedList = (await listInvitations(owner, tenant)).find((row: any) => row.id === invitation.id);
    assert.equal(acceptedList.invitationStatus, "accepted");

    // Acceptance and cancellation serialize on the invitation row; exactly one terminal outcome wins.
    const raceInvitee = await user(pool, "race-invitee");
    const raceEmail = `${mark}-race-invitee@example.test`;
    const raceInvitation = await invite(owner, tenant, raceEmail, "viewer");
    const race = await Promise.allSettled([
      acceptInvite(raceInvitee, raceInvitation.token),
      revokeInvitation(owner, tenant, raceInvitation.id),
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(race.some((result) => result.status === "rejected" && /deadlock/i.test(String(result.reason))), false);
    const raceState = (await pool.query("SELECT accepted_at,revoked_at FROM company_invitations WHERE id=$1", [raceInvitation.id])).rows[0];
    assert.notEqual(Boolean(raceState.accepted_at), Boolean(raceState.revoked_at));

    const own = await order(pool, buyer, tenant);
    const adminOrder = await order(pool, admin, tenant);
    await order(pool, owner, otherTenant);
    assert.ok((await listCustomerOrders(owner, 1, 50, "company", tenant)).items.some((x: any) => x.id === own));
    assert.ok((await listCustomerOrders(admin, 1, 50, "company", tenant)).items.some((x: any) => x.id === adminOrder));
    const buyerOrders = await listCustomerOrders(buyer, 1, 50, "placed");
    assert.deepEqual(buyerOrders.items.map((x: any) => x.id), [own]);
    await assert.rejects(() => getOrder(own, { userId: viewer }), /not found/i);

    const proof = { session: `${mark}-guest`, token: createOpaqueToken() };
    const guestOrder = await order(pool, null, null, proof);
    await assert.rejects(() => claimGuestOrder(outsider, guestOrder, `${proof.session}-bad`, proof.token), /not found/i);
    await claimGuestOrder(outsider, guestOrder, proof.session, proof.token);
    await assert.rejects(() => claimGuestOrder(outsider, guestOrder, proof.session, proof.token), /not found/i);
    const preserved = (await pool.query("SELECT o.guest_session_id,g.guest_session_id AS claim_session FROM orders o JOIN guest_order_claims g ON g.order_id=o.id WHERE o.id=$1", [guestOrder])).rows[0];
    assert.equal(preserved.guest_session_id, proof.session); assert.equal(preserved.claim_session, proof.session);

    console.info("Customer accounts integration checks passed.");
  } finally {
    if (orderIds.length) await pool.query("DELETE FROM audit_logs WHERE entity_id=ANY($1::uuid[])", [orderIds]);
    if (orderIds.length) await pool.query("DELETE FROM orders WHERE id=ANY($1::uuid[])", [orderIds]);
    // Invitation deliveries refer to their invitation through metadata rather than a FK.
    if (companyIds.length) await pool.query(`DELETE FROM notification_deliveries WHERE event_type='company.invitation'
      AND metadata_json->>'companyId'=ANY($1::text[])`, [companyIds]);
    if (companyIds.length) await pool.query("DELETE FROM audit_logs WHERE entity_id=ANY($1::uuid[])", [companyIds]);
    if (companyIds.length) await pool.query("DELETE FROM companies WHERE id=ANY($1::uuid[])", [companyIds]);
    if (userIds.length) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    await closeDatabase();
  }
}
run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });