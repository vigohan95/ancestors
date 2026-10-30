import { retrieveComments, commitsForPath, charterFor, fmtEvidence } from './retrieve.js';
import { ancestorsAgent } from './mastra.js';
import { migrate } from './db.js';

/** Ask the ancestors a question about the codebase; they answer only from cited evidence. */
export async function ask(repo: string, question: string, pathHint?: string, thread?: string): Promise<string> {
  await migrate();
  const evidence = await retrieveComments(repo, question, pathHint, { topK: 8 });
  const commits = pathHint ? await commitsForPath(repo, pathHint, 8) : [];
  const charter = await charterFor(repo);
  const prompt = [
    `Question from a living maintainer of ${repo}: ${question}`,
    commits.length ? `Commits touching ${pathHint}:\n${commits.map(c => `[${c.sha.slice(0, 7)}] ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`).join('\n')}` : '',
    charter ? `Your charter:\n${charter}` : '',
    `Evidence (the only things you may cite):\n${fmtEvidence(evidence) || '(none found)'}`,
    'Answer in at most 180 words. Cite ids like [c123] or [abc1234] after each claim. If the evidence does not answer the question, say so plainly and suggest what to look at.',
  ].filter(Boolean).join('\n\n');
  const res = await ancestorsAgent.generate(prompt, thread ? { memory: { thread, resource: repo } } : {});
  const refs = evidence.map(e => `- [c${e.id}] ${e.author} ${e.created_at.slice(0, 10)} ${e.url}`).join('\n');
  return `${res.text.trim()}\n\nSources retrieved:\n${refs}`;
}
