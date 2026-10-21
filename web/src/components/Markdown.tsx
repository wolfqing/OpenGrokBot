import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

/**
 * 同事的话按 markdown 显示，但有三条规矩：
 * - 链接新开标签页，并且不把本页交给对方（noopener）。
 * - 不加载图片：模型复述网页时可能夹带追踪像素。只显示一行占位和它的说明文字。
 * - 模型夹带的原始 HTML 直接丢掉；javascript: 之类的链接协议 react-markdown 默认就会去掉。
 * 另外单个换行就是换行（remark-breaks）：Chief 的分派表一行一条，模型也常用单换行分行，不能被折成空格。
 */
const components: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
  img: ({ node: _node, alt }) => <span className="md-image">[image{alt ? `: ${alt}` : ''}]</span>,
}

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={components}
      skipHtml
    >
      {text}
    </ReactMarkdown>
  )
}
