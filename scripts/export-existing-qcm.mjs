#!/usr/bin/env node
// Copies the existing local QCM into import JSON without rewriting question text.
// The JSON output is written outside the published outputs/ directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '../..');
const archiveDir = path.join(workspaceRoot, 'work', 'legacy-qcm');
const sourceHtml = path.join(archiveDir, 'index-before-supabase.html');
const outputDir = path.resolve(process.argv[2] || path.join(workspaceRoot, 'work', 'supabase-import'));
const html = await fs.readFile(sourceHtml, 'utf8');

const dataStart = html.indexOf('const questions = [');
const dataEnd = html.indexOf("const STORAGE='medqcm-v1';", dataStart);
const moduleStart = html.indexOf('const BIOCHIMIE_PARTS=[', dataEnd);
const moduleEnd = html.indexOf('let activePartKey=', moduleStart);
if ([dataStart, dataEnd, moduleStart, moduleEnd].some(index => index < 0)) {
  throw new Error('Could not locate the existing QCM data and lesson map in the archived index.html.');
}

const context = vm.createContext({ console });
context.window = context;
vm.runInContext(`${html.slice(dataStart, dataEnd)}\nglobalThis.__dlmedQuestions = questions;`, context, { timeout: 5000 });

const dataFiles = [
  'biochimie-homme-sain.js',
  'biochimie-etapes-analyse.js',
  'biochimie-marqueurs-cardiaques.js',
  'physio-choc-hypovolemique.js',
  'physio-mtev.js',
  'physio-ira.js',
  'psychologie-relation-medecin-malade.js',
  'semiologie-nouveaux-chapitres.js',
  'semiologie-examen-physique.js'
];
for (const file of dataFiles) {
  vm.runInContext(await fs.readFile(path.join(archiveDir, file), 'utf8'), context, { timeout: 5000, filename: file });
}
vm.runInContext(`${html.slice(moduleStart, moduleEnd)}\nglobalThis.__dlmedParts = PARTS;`, context, { timeout: 5000 });

const parts = context.__dlmedParts;
const letters = ['A', 'B', 'C', 'D', 'E'];
const subjectMeta = {
  biochimie: { name: 'Biochimie', icon: '🧪', sort_order: 1 },
  physiopathologie: { name: 'Physiopathologie', icon: '🫀', sort_order: 2 },
  psychologie: { name: 'Psychologie médicale', icon: '🧠', sort_order: 3 },
  semiologie: { name: 'Sémiologie', icon: '🩺', sort_order: 5 }
};
const subjectLessonOrder = new Map();
const exported = [];
const baseLessons = [
  { name: 'Partie 1 · Sémiologie de l’ECG', start: 1, end: 40, sort_order: 1 },
  { name: 'Partie 2 · Syndrome coronarien aigu', start: 41, end: 60, sort_order: 2 },
  { name: 'Troubles de l’hydratation', start: 61, end: 120, sort_order: 3 },
  { name: 'Sémiologie pondérale', start: 121, end: 160, sort_order: 4 },
  { name: 'Hémodynamique', start: 161, end: 190, sort_order: 5 },
  { name: 'Signes fonctionnels en cardiologie', start: 191, end: 220, sort_order: 6 },
  { name: 'Les insuffisances cardiaques', start: 221, end: 260, sort_order: 7 }
];

function convertQuestion(item, lessonName) {
  const options = Array.isArray(item.options) ? item.options : [];
  if (options.length !== 5 || options.some(option => typeof option !== 'string')) {
    throw new Error(`Question ${item.id ?? '?'} in '${lessonName}' does not have five text choices.`);
  }
  const answer = Array.isArray(item.answer) ? item.answer : [item.answer];
  const correctOptions = answer.map(value => {
    const position = Number(value);
    if (!Number.isInteger(position) || position < 0 || position > 4) throw new Error(`Invalid source answer in '${lessonName}', question ${item.id ?? '?'}.`);
    return letters[position];
  });
  if (!correctOptions.length) throw new Error(`Question ${item.id ?? '?'} in '${lessonName}' has no correct answer.`);
  return {
    question: item.text,
    options: { mode: correctOptions.length > 1 ? 'multiple' : 'single', choices: Object.fromEntries(letters.map((letter, i) => [letter, options[i]])) },
    correct_options: correctOptions,
    explanation: item.explanation
  };
}

for (const lesson of baseLessons) {
  const sourceQuestions = context.__dlmedQuestions.filter(question => question.id >= lesson.start && question.id <= lesson.end);
  if (sourceQuestions.length !== lesson.end - lesson.start + 1) {
    throw new Error(`Expected ${lesson.end - lesson.start + 1} questions for '${lesson.name}', found ${sourceQuestions.length}.`);
  }
  exported.push({
    outputName: `${String(lesson.start).padStart(4, '0')}-${lesson.name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`,
    document: {
      subject: subjectMeta.semiologie,
      lesson: { title: lesson.name, sort_order: lesson.sort_order },
      questions: sourceQuestions.map(item => convertQuestion(item, lesson.name))
    },
    count: sourceQuestions.length,
    subject: subjectMeta.semiologie.name,
    lesson: lesson.name
  });
}

for (const part of [...parts].sort((a, b) => a.start - b.start)) {
  const group = part.group || 'semiologie';
  const meta = subjectMeta[group];
  if (!meta) throw new Error(`Unknown subject group '${group}' in lesson '${part.name}'.`);
  const sourceQuestions = Array.isArray(part.questions) ? part.questions : [];
  if (!sourceQuestions.length) continue;
  const questions = sourceQuestions.map(item => convertQuestion(item, part.name));
  const count = subjectLessonOrder.get(group) || 0;
  subjectLessonOrder.set(group, count + 1);
  const document = {
    subject: meta,
    lesson: { title: part.name, sort_order: part.start || count + 1 },
    questions
  };
  const safeSlug = part.name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const outputName = `${String(part.start || count + 1).padStart(4, '0')}-${safeSlug}.json`;
  exported.push({ outputName, document, count: questions.length, subject: meta.name, lesson: part.name });
}

exported.sort((a, b) => {
  const aNumber = Number(a.outputName.match(/^\d+/)?.[0] || 0);
  const bNumber = Number(b.outputName.match(/^\d+/)?.[0] || 0);
  return aNumber - bNumber || a.outputName.localeCompare(b.outputName);
});

await fs.mkdir(outputDir, { recursive: true });
for (const item of exported) {
  await fs.writeFile(path.join(outputDir, item.outputName), `${JSON.stringify(item.document, null, 2)}\n`, 'utf8');
}
const total = exported.reduce((sum, item) => sum + item.count, 0);
console.table(exported.map(({ subject, lesson, count, outputName }) => ({ subject, lesson, questions: count, file: outputName })));
if (total !== 590) throw new Error(`The expected current bank has 590 questions, but the export contains ${total}.`);
console.log(`Exported ${total} existing questions to ${outputDir}. No Supabase rows were written.`);
