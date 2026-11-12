import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './MessageContent.css';

export default function MessageContent({ text }: { text: string }) {
  return (
    <div className="message-content">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          // Model output must not trigger image requests to arbitrary destinations.
          img: ({ alt }) => <span className="muted">[Image: {alt || 'attachment'}]</span>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="message-table-scroll" tabIndex={0} role="region" aria-label="Message table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
