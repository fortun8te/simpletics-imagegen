// adType.ts — client-side ad-type classification (mirror of lib/planner.mjs classifyAdType).
// Deterministic keyword rules; used for the type chips on Plan ad sections. Keep the two rule
// tables in sync — they're intentionally tiny.

export type AdType = 'native' | 'static' | 'offer' | 'carousel' | 'ugc' | 'face';

const RULES: { type: AdType; re: RegExp }[] = [
  { type: 'carousel', re: /carousel|slide|2x2|3x3|grid/i },
  { type: 'ugc', re: /ugc|ugly|candid|selfie|iphone photo|first-person|phone photo/i },
  { type: 'offer', re: /offer|% ?off|discount|sale|price|bundle|free shipping/i },
  { type: 'native', re: /native|testimonial|review|quote|customer/i },
];

export function classifyAdType(parts: { kind?: string; type?: string; title?: string; text?: string }): AdType {
  if (parts.kind === 'face') return 'face';
  const hay = [parts.type, parts.title, parts.text].filter(Boolean).join(' ');
  for (const r of RULES) if (r.re.test(hay)) return r.type;
  return 'static';
}
