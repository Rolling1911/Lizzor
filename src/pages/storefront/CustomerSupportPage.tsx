import { useEffect, useState } from "react";
import { apiRequest } from "../../auth/api";
import { ErrorState, LoadingState, StatusBadge } from "../../components/admin/AdminPrimitives";
import { Icon } from "../../components/ui/Icon";

type Ticket = { id: string; ticketNumber: string; subject: string; status: string; companyName: string | null; orderNumber: string | null; lastMessage: string | null; updatedAt: string };
type Detail = { ticket: Ticket; messages: Array<{ id: string; message: string; isSupport: boolean; createdAt: string }> };
type Company = { id: string; companyName: string };
type Order = { id: string; orderNumber: string; companyId?: string | null };

function formatTicketStatus(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function CustomerSupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setLoading(true);
    try { setTickets((await apiRequest<{ data: { items: Ticket[] } }>("/support/tickets")).data.items); }
    catch (e) { setError(e instanceof Error ? e.message : "Your support tickets could not be loaded."); }
    finally { setLoading(false); }
  }
  async function inspect(id: string) {
    try { setDetail((await apiRequest<{ data: Detail }>(`/support/tickets/${id}`)).data); }
    catch (e) { setError(e instanceof Error ? e.message : "This ticket could not be loaded."); }
  }
  useEffect(() => {
    void load();
    void Promise.all([
      apiRequest<{ data: { items?: Company[] } | Company[] }>("/account/companies"),
      apiRequest<{ data: { items?: Order[] } | Order[] }>("/account/orders?pageSize=100"),
    ]).then(([companyResult, orderResult]) => {
      setCompanies(Array.isArray(companyResult.data) ? companyResult.data : companyResult.data.items ?? []);
      setOrders(Array.isArray(orderResult.data) ? orderResult.data : orderResult.data.items ?? []);
    }).catch(() => { /* Optional context does not block support. */ });
  }, []);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const created = (await apiRequest<{ data: { id: string } }>("/support/tickets", { method: "POST", body: JSON.stringify({ subject, message, companyId: companyId || null, orderId: orderId || null }) })).data;
      setSubject(""); setMessage(""); setCompanyId(""); setOrderId(""); setNotice("Your ticket was created.");
      await load(); await inspect(created.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Your ticket could not be created."); }
    finally { setBusy(false); }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!detail) return; setBusy(true);
    try {
      await apiRequest(`/support/tickets/${detail.ticket.id}/messages`, { method: "POST", body: JSON.stringify({ message: reply }) });
      setReply(""); setNotice("Your reply was added."); await load(); await inspect(detail.ticket.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Your reply could not be added."); }
    finally { setBusy(false); }
  }
  const visibleOrders = orders.filter((order) => companyId ? order.companyId === companyId : !order.companyId);

  return <main className="storefront-support">
    <header className="storefront-support__header">
      <div className="storefront-support__header-copy">
        <span className="eyebrow">Customer care</span>
        <h1>How can we help?</h1>
        <p>Create a support request or continue a conversation with the Lizzor team.</p>
      </div>
      <div className="storefront-support__header-mark" aria-hidden="true">
        <Icon name="messages-square" size={30} />
        <span>CARE / 24</span>
      </div>
    </header>
    {notice && <p className="catalog-notice" role="status">{notice}</p>}
    {error && <ErrorState title="Support unavailable" description={error} onRetry={() => void load()} />}
    <div className="storefront-support__grid">
      <section className="support-card support-request-card">
        <div className="support-card__heading">
          <div>
            <span className="eyebrow">Start here</span>
            <h2>New support request</h2>
          </div>
          <span className="support-card__icon"><Icon name="ticket" size={18} /></span>
        </div>
        <form className="support-form" onSubmit={create}>
          <label className="support-field"><span>Subject</span><input required minLength={3} maxLength={250} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What do you need help with?" /></label>
          <label className="support-field"><span>Company <em>Optional</em></span><select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setOrderId(""); }}><option value="">Personal support</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.companyName}</option>)}</select></label>
          <label className="support-field"><span>Related order <em>Optional</em></span><select value={orderId} onChange={(e) => setOrderId(e.target.value)}><option value="">No specific order</option>{visibleOrders.map((order) => <option key={order.id} value={order.id}>{order.orderNumber}</option>)}</select></label>
          <label className="support-field support-field--message"><span>Message</span><textarea required rows={6} maxLength={10000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Include the details our team needs." /></label>
          <button className="button button--support" disabled={busy}>{busy ? "Creating…" : "Create ticket"}<Icon name="arrow-right" size={16} /></button>
        </form>
        <div className="support-section-heading">
          <div>
            <span className="eyebrow">History</span>
            <h2>Your tickets</h2>
          </div>
          {tickets.length > 0 && <span className="support-count">{tickets.length}</span>}
        </div>
        {loading ? <LoadingState label="Loading your tickets…" /> : tickets.length ? <div className="support-ticket-list">{tickets.map((ticket) => <button key={ticket.id} className={detail?.ticket.id === ticket.id ? "is-selected" : undefined} onClick={() => void inspect(ticket.id)}>
          <span className="support-ticket-list__main">
            <span className="support-ticket-list__top"><strong>{ticket.subject}</strong><StatusBadge status={formatTicketStatus(ticket.status)} tone={["closed", "resolved"].includes(ticket.status) ? "positive" : "neutral"} /></span>
            <span className="support-ticket-list__meta"><code>{ticket.ticketNumber}</code><span>Updated {new Date(ticket.updatedAt).toLocaleDateString()}</span></span>
            {(ticket.companyName || ticket.orderNumber) && <span className="support-ticket-list__context">{ticket.companyName}{ticket.companyName && ticket.orderNumber ? " · " : ""}{ticket.orderNumber ? `Order ${ticket.orderNumber}` : ""}</span>}
          </span>
          <Icon name="chevron-down" size={15} className="support-ticket-list__arrow" />
        </button>)}</div> : <div className="support-empty support-empty--tickets"><span className="support-empty__icon"><Icon name="life-buoy" size={22} /></span><h3>No support requests yet</h3><p>Create your first ticket and our team will help you here.</p></div>}
      </section>
      <section className="support-card support-conversation-card">
        {detail ? <><div className="support-conversation__heading"><div className="support-conversation__title"><span className="support-card__icon"><Icon name="messages-square" size={18} /></span><div><span className="eyebrow">{detail.ticket.ticketNumber}</span><h2>{detail.ticket.subject}</h2></div></div><StatusBadge status={formatTicketStatus(detail.ticket.status)} tone={["closed", "resolved"].includes(detail.ticket.status) ? "positive" : "neutral"} /></div>
          {(detail.ticket.orderNumber || detail.ticket.companyName) && <p className="support-conversation__context"><Icon name="building-2" size={14} />{detail.ticket.companyName}{detail.ticket.orderNumber ? ` · Order ${detail.ticket.orderNumber}` : ""}</p>}
          <div className="care-message-list">{detail.messages.map((entry) => <article className={entry.isSupport ? "care-message care-message--admin" : "care-message"} key={entry.id}><div><strong>{entry.isSupport ? "Lizzor support" : "You"}</strong><time>{new Date(entry.createdAt).toLocaleString()}</time></div><p>{entry.message}</p></article>)}</div>
          {detail.ticket.status !== "closed" && <form className="support-reply-form" onSubmit={send}><label className="support-field"><span>Continue the conversation</span><textarea required rows={4} maxLength={10000} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Add a reply…" /></label><button className="button button--support" disabled={busy}>{busy ? "Sending…" : "Send reply"}<Icon name="arrow-right" size={16} /></button></form>}</> : <div className="support-empty support-empty--conversation"><span className="support-empty__icon"><Icon name="messages-square" size={25} /></span><h2>Choose a ticket</h2><p>Open a ticket to view its history and continue the conversation.</p></div>}
      </section>
    </div>
  </main>;
}