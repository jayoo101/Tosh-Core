import fs from 'fs';
import path from 'path';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const metadata = {
  title: 'MeritX Litepaper',
  description: 'The official manifesto and tokenomics of the MeritX protocol.',
};

export default function LitepaperPage() {
  let content = '';
  try {
    const filePath = path.join(process.cwd(), 'public', 'litepaper.md');
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    content = '# Litepaper Not Found\nPlease place `litepaper.md` in the `public` directory.';
  }

  return (
    <div className="min-h-screen bg-black text-gray-200 py-20 px-6 sm:px-12 lg:px-24">
      <div className="max-w-4xl mx-auto">
        {/* Decorative Header */}
        <div className="mb-12 border-b border-white/10 pb-8">
          <h1 className="text-4xl md:text-5xl font-extrabold text-white tracking-tight mb-4">
            MERITX <span className="text-blue-500">LITEPAPER</span>
          </h1>
          <div className="flex items-center space-x-2 text-sm text-gray-500 font-mono">
            <span className="animate-pulse h-2 w-2 bg-blue-500 rounded-full"></span>
            <span>SYSTEM.DOCS.LOADED</span>
          </div>
        </div>

        {/* Markdown Content rendered with Tailwind Typography */}
        <article className="prose prose-invert prose-blue max-w-none
          prose-headings:font-bold prose-h1:text-3xl prose-h2:text-2xl
          prose-a:text-blue-400 prose-a:no-underline hover:prose-a:text-blue-300
          prose-code:text-pink-400 prose-code:bg-white/5 prose-code:px-1 prose-code:rounded
          prose-pre:bg-white/5 prose-pre:border prose-pre:border-white/10">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {content}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
