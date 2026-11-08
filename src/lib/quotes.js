export const QUOTES = [
  { text: 'Discipline is choosing between what you want now and what you want most.', author: 'Abraham Lincoln' },
  { text: 'The successful warrior is the average person with laser-like focus.', author: 'Bruce Lee' },
  { text: 'You do not rise to the level of your goals. You fall to the level of your systems.', author: 'James Clear' },
  { text: 'Amateurs sit and wait for inspiration; the rest of us just get up and go to work.', author: 'Stephen King' },
  { text: 'It is not that we have a short time to live, but that we waste a lot of it.', author: 'Seneca' },
  { text: 'Concentrate all your thoughts upon the work in hand.', author: 'Alexander Graham Bell' },
  { text: 'The art of being wise is the art of knowing what to overlook.', author: 'William James' },
  { text: 'Where focus goes, energy flows.', author: 'Tony Robbins' },
  { text: 'Simplicity boils down to two steps: identify the essential, eliminate the rest.', author: 'Leo Babauta' },
  { text: 'Well done is better than well said.', author: 'Benjamin Franklin' },
  { text: 'Action is the foundational key to all success.', author: 'Pablo Picasso' },
  { text: 'He who has a why to live can bear almost any how.', author: 'Friedrich Nietzsche' },
  { text: 'The way to get started is to quit talking and begin doing.', author: 'Walt Disney' },
  { text: 'If it is important, do it every day. If it is not, do not do it at all.', author: 'Dan Gable' },
  { text: 'Focus is a matter of deciding what things you are not going to do.', author: 'John Carmack' },
  { text: 'Small deeds done are better than great deeds planned.', author: 'Peter Marshall' },
  { text: 'You will never always be motivated. You must learn to be disciplined.', author: 'Unknown' },
  { text: 'The distracted multitude admits no delay.', author: 'Ovid' },
  { text: 'Nothing is less productive than to make more efficient what should not be done at all.', author: 'Peter Drucker' },
  { text: 'Between stimulus and response there is a space. In that space is our power to choose.', author: 'Viktor Frankl' },
  { text: 'Do the hard jobs first. The easy jobs will take care of themselves.', author: 'Dale Carnegie' },
  { text: 'A year from now you may wish you had started today.', author: 'Karen Lamb' },
  { text: 'Attention is the rarest and purest form of generosity.', author: 'Simone Weil' },
  { text: 'Lost time is never found again.', author: 'Benjamin Franklin' },
  { text: 'Every time you say yes to something unimportant, you say no to something important.', author: 'Robin Sharma' },
  { text: 'The effective person focuses on contribution.', author: 'Peter Drucker' },
  { text: 'Work is hard. Distractions are easy. Choose the hard that pays.', author: 'Unknown' },
  { text: 'Do not spend time dreaming of the future; build it now, brick by brick.', author: 'Unknown' },
  { text: 'One does not conquer distraction by willpower alone, but by design.', author: 'Unknown' },
  { text: 'The scariest enemy of focus is not noise — it is comfortable noise.', author: 'Unknown' },
];

export function randomQuoteIndex(excludeIndex) {
  if (QUOTES.length === 0) return -1;
  if (QUOTES.length === 1) return 0;
  let idx = Math.floor(Math.random() * QUOTES.length);
  if (idx === excludeIndex) idx = (idx + 1) % QUOTES.length;
  return idx;
}
