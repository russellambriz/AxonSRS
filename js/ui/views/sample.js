/** Sample deck that demonstrates each answer mode and card type. */

import { store } from '../../data/store.js';
import { createCard } from '../../core/model.js';

export async function createSampleDeck() {
  const deck = await store.createDeck({ name: 'Axon tour', description: 'A few cards that show typed answers in text, mathematics and chemistry, cloze deletions, hints and worked solutions.', settings: { newPerDay: 20 } });
  const cards = [
    { front: 'What is the capital of Australia?', back: 'Canberra', tags: ['geography'] },
    { front: 'Largest planet in the Solar System', back: 'Jupiter', hint: 'A gas giant, fifth from the Sun', tags: ['astronomy'] },
    { front: 'Formula of the **sulfate** ion', back: 'SO4^2-', answerMode: 'chem', tags: ['chemistry', 'ions'], explanation: 'Type it however you like: SO4^2-, SO₄²⁻ or SO4 2-. A wrong charge or atom count is never accepted.' },
    { front: 'Formula of the **ammonium** ion', back: 'NH4^+', answerMode: 'chem', tags: ['chemistry', 'ions'] },
    { front: 'Balance: hydrogen + oxygen → water', back: '2H2 + O2 -> 2H2O', answerMode: 'chem', tags: ['chemistry'], taskType: 'calculation' },
    { front: '$\\sin(\\pi/4)$', back: 'sqrt(2)/2 | 1/sqrt(2)', answerMode: 'math', tags: ['trigonometry'], explanation: 'Both forms are listed as accepted answers (separated by |). Notation variants such as √2/2 are matched automatically.' },
    { front: 'Derivative of $\\sin(x)$', back: 'cos(x)', answerMode: 'math', tags: ['calculus'] },
    { front: '$\\displaystyle\\int 2x\\,dx$', back: 'x^2 + C', answerMode: 'math', tags: ['calculus'], explanation: 'Power rule: $\\int x^n\\,dx = \\frac{x^{n+1}}{n+1} + C$. Forgetting **+ C** is flagged specifically.' },
    { front: 'Compute $12 \\times 15$', back: '180', answerMode: 'math', taskType: 'calculation', tags: ['arithmetic'], explanation: '$12 \\times 15 = 12 \\times 10 + 12 \\times 5 = 120 + 60 = 180$' },
    { front: 'Speed of light in vacuum, in m/s (scientific notation)', back: '2.998e8 | 3e8', answerMode: 'math', match: { numericTolerance: '0.5%' }, tags: ['physics'], explanation: 'This card accepts any value within 0.5% (a per-card numeric tolerance).' },
    { front: '{{c1::Mitochondria}} are the main site of {{c2::aerobic respiration::process}} in eukaryotic cells.', back: '', tags: ['biology'] },
  ];
  await store.saveCards(cards.map((c) => createCard({ ...c, deckId: deck.id }, store.deviceId)));
  return deck;
}
