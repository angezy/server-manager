import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ content }: { content: string }): JSX.Element { return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code({ className, children, ...props }) { const text = String(children).replace(/\n$/, ''); return <div className="code-wrap"><button className="copy-code" onClick={() => void navigator.clipboard.writeText(text)}>Copy</button><pre className={className}><code {...props}>{text}</code></pre></div>; } }}>{content}</ReactMarkdown>; }
