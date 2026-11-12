import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Markdown typography for model and owner messages. */
const prose = [
  'min-w-0 leading-relaxed [overflow-wrap:anywhere] [&>*+*]:mt-3',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li+li]:mt-1',
  '[&_a]:text-link [&_a]:underline [&_a]:underline-offset-3',
  '[&_strong]:font-semibold [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h1,&_h2,&_h3]:font-semibold',
  '[&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-code [&_pre]:p-3.5 [&_pre]:whitespace-pre',
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-code [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-primary [&_blockquote]:pl-3.5 [&_blockquote]:text-muted-foreground',
].join(' ');

export default function MessageContent({ text }: { text: string }) {
  return (
    <div data-slot="message-content" className={prose}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          // Model output must not trigger image requests to arbitrary destinations.
          img: ({ alt }) => <span className="text-muted-foreground">[Image: {alt || 'attachment'}]</span>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="max-w-full overflow-auto" tabIndex={0} role="region" aria-label="Message table">
              <table className="w-full border-collapse text-xs [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:whitespace-nowrap [&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground">
                {children}
              </table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
