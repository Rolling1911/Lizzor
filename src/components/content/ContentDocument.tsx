import type { ReactNode } from "react";

export type ContentDocumentJson = { type: "doc"; content?: ContentNode[] };
export type ContentNode = { type: string; text?: string; attrs?: Record<string, any>; content?: ContentNode[]; marks?: Array<{ type: string; attrs?: Record<string, any> }> };

function safeHref(href: unknown) {
  return typeof href === "string" && (/^(https?:|mailto:|tel:)/i.test(href) || /^\/(?!\/)/.test(href)) ? href : null;
}

function renderText(node: ContentNode, key: string | number): ReactNode {
  let child: ReactNode = node.text || "";
  for (const mark of node.marks || []) {
    if (mark.type === "bold") child = <strong key={`${key}-bold`}>{child}</strong>;
    else if (mark.type === "italic") child = <em key={`${key}-italic`}>{child}</em>;
    else if (mark.type === "link") { const href = safeHref(mark.attrs?.href); child = href ? <a key={`${key}-link`} href={href} {...(/^https?:/i.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{child}</a> : child; }
  }
  return child;
}

function renderNode(node: ContentNode, key: string | number): ReactNode {
  if (node.type === "text") return renderText(node, key);
  const children = (node.content || []).map((item, index) => renderNode(item, `${key}-${index}`));
  switch (node.type) {
    case "paragraph": return <p key={key}>{children}</p>;
    case "heading": return node.attrs?.level === 4 ? <h4 key={key}>{children}</h4> : node.attrs?.level === 3 ? <h3 key={key}>{children}</h3> : <h2 key={key}>{children}</h2>;
    case "bulletList": return <ul key={key}>{children}</ul>;
    case "orderedList": return <ol key={key}>{children}</ol>;
    case "listItem": return <li key={key}>{children}</li>;
    case "blockquote": return <blockquote key={key}>{children}</blockquote>;
    case "hardBreak": return <br key={key} />;
    case "table": return <table key={key}><tbody>{children}</tbody></table>;
    case "tableRow": return <tr key={key}>{children}</tr>;
    case "tableHeader": return <th key={key} colSpan={node.attrs?.colspan || 1} rowSpan={node.attrs?.rowspan || 1}>{children}</th>;
    case "tableCell": return <td key={key} colSpan={node.attrs?.colspan || 1} rowSpan={node.attrs?.rowspan || 1}>{children}</td>;
    default: return <>{children}</>;
  }
}

export function ContentDocument({ body }: { body: ContentDocumentJson }) {
  return <div className="content-document">{(body?.content || []).map((node, index) => renderNode(node, index))}</div>;
}