import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../../auth/api";
import { useAuth } from "../../auth/AuthContext";
import { ErrorState, EmptyState, LoadingState } from "../../components/admin/AdminPrimitives";

type ChatMessage = { id: string; message: string; isAdmin?: boolean; createdAt: string };
type ChatSession = { id: string; status: "open" | "closed"; createdAt: string; updatedAt: string };

export function CustomerChatPage() {
  const { user } = useAuth();
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      const result = (await apiRequest<{ data: { session: ChatSession | null; messages: ChatMessage[] } }>("/chat/session")).data;
      setSession(result.session); setMessages(result.messages);
    } catch (e) { setError(e instanceof Error ? e.message : "Chat is unavailable right now."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10000); return () => window.clearInterval(timer); }, []);
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!message.trim()) return; setBusy(true); setError("");
    try {
      const result = (await apiRequest<{ data: { sessionId: string; message: ChatMessage } }>("/chat/messages", { method: "POST", body: JSON.stringify({ message }) })).data;
      const isNewSession = session?.id !== result.sessionId;
      setSession({ id: result.sessionId, status: "open", createdAt: isNewSession ? result.message.createdAt : session.createdAt, updatedAt: result.message.createdAt });
      setMessages((current) => isNewSession ? [result.message] : [...current, result.message]); setMessage(""); setNotice("Message sent. We’ll reply here.");
    } catch (e) { setError(e instanceof Error ? e.message : "Your message could not be sent."); }
    finally { setBusy(false); }
  }
  return <main className="storefront-support storefront-chat">
    <header className="storefront-support__header"><span className="eyebrow">Live customer care</span><h1>Chat with Lizzor</h1><p>{user ? "Send a message to our team and keep the conversation in your account." : "Send a message without an account. Your conversation stays linked to this browser."}</p></header>
    {notice && <p className="catalog-notice" role="status">{notice}</p>}{error && <ErrorState title="Chat unavailable" description={error} onRetry={() => void load()} />}
    <section className="admin-panel storefront-chat__panel"><div className="admin-panel__heading"><div><span className="eyebrow">Conversation</span><h2>{session ? "Your Lizzor chat" : "Start a conversation"}</h2></div><span className="foundation-chip"><span className="status-dot" /> Refreshes every 10 seconds</span></div>
      {loading ? <LoadingState label="Loading your conversation…" /> : <>{session && messages.length ? <div className="care-message-list">{messages.map((entry) => <article className={entry.isAdmin ? "care-message care-message--admin" : "care-message"} key={entry.id}><div><strong>{entry.isAdmin ? "Lizzor support" : "You"}</strong><time>{new Date(entry.createdAt).toLocaleString()}</time></div><p>{entry.message}</p></article>)}</div> : <EmptyState title="No messages yet" description="Send the first message and this browser will receive replies for this conversation." icon="life-buoy" />}{session?.status === "closed" ? <form className="catalog-stack" onSubmit={send}><p className="section-note">This conversation is closed. Sending a message starts a new chat.</p><textarea required rows={5} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Start a new conversation…" /><button className="button button--dark" disabled={busy}>{busy ? "Sending…" : "Start new chat"}</button></form> : <form className="catalog-stack" onSubmit={send}><textarea required rows={5} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Tell us how we can help…" /><button className="button button--dark" disabled={busy}>{busy ? "Sending…" : "Send message"}</button></form>}</>}</section>
    <p className="section-note storefront-chat__footer"><Link to="/support">Need an order-specific request? Open support tickets instead.</Link></p>
  </main>;
}