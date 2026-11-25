import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const directory = arg('--directory');
if (!directory) throw new Error('Pass --directory with the folder containing the UEI 1 Markdown files.');
const mode = arg('--mode', 'summary');
const onlyExam = Number(arg('--exam', '0')) || 0;
const ranges = [
  [1, 10, 'Cas cliniques'],
  [11, 15, 'Radiologie'],
  [16, 20, 'Psychologie médicale'],
  [21, 32, 'Physiopathologie'],
  [33, 62, 'Sémiologie'],
  [63, 67, 'Biochimie']
];

function cleanText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_\x60]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionFor(number) {
  return ranges.find(([start, end]) => number >= start && number <= end)?.[2] || 'UEI 1';
}

function parseQuestionFile(file, examNumber) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const questions = [];
  let current = null;
  let currentCase = '';
  let caseLines = [];
  let collectingCase = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^##\s/.test(line) && !/^###/.test(line)) {
      current = null;
      currentCase = '';
      caseLines = [];
      collectingCase = false;
      continue;
    }
    const caseHeading = line.match(/^###\s+(Cas\b.*)$/i);
    if (caseHeading) {
      current = null;
      currentCase = cleanText(caseHeading[1]);
      caseLines = [];
      collectingCase = true;
      continue;
    }
    const questionHeading = line.match(/^\*\*(\d+)\.\*\*\s*(.*)$/);
    if (questionHeading) {
      const questionNumber = Number(questionHeading[1]);
      const promptAndType = questionHeading[2].trim();
      const typeMatch = promptAndType.match(/\*\(([^)]+)\)\*\s*$/);
      const questionType = cleanText(typeMatch?.[1] || '');
      const prompt = cleanText(typeMatch
        ? promptAndType.slice(0, typeMatch.index)
        : promptAndType);
      const context = [currentCase, cleanText(caseLines.join(' '))]
        .filter(Boolean).join('\n\n');
      current = {
        test_number: examNumber,
        question_number: questionNumber,
        section: sectionFor(questionNumber),
        question_type: questionType || 'QCM',
        question: context ? context + '\n\n' + prompt : prompt,
        optionMap: new Map(),
        lastOption: ''
      };
      questions.push(current);
      collectingCase = false;
      continue;
    }
    if (!current) {
      if (collectingCase && line) caseLines.push(line);
      continue;
    }
    const optionMatch = line.match(/^([A-E])\s*[.)]\s*(.*)$/);
    if (optionMatch) {
      const letter = optionMatch[1].toUpperCase();
      current.optionMap.set(letter, cleanText(optionMatch[2]));
      current.lastOption = letter;
      continue;
    }
    if (!line) continue;
    if (current.optionMap.size && current.lastOption) {
      const previous = current.optionMap.get(current.lastOption) || '';
      current.optionMap.set(current.lastOption, cleanText(previous + ' ' + line));
    } else {
      current.question = cleanText(current.question + ' ' + line);
    }
  }

  return questions.map(question => {
    const letters = [...question.optionMap.keys()].sort();
    if (letters.join('') !== 'ABCDE') {
      throw new Error(path.basename(file) + ' Q' + question.question_number + ': choix trouvés ' + (letters.join(',') || 'aucun'));
    }
    const options = letters.map(letter => ({ letter, text: question.optionMap.get(letter) }));
    if (options.some(option => !option.text)) {
      throw new Error(path.basename(file) + ' Q' + question.question_number + ': proposition vide');
    }
    return {
      test_number: question.test_number,
      question_number: question.question_number,
      section: question.section,
      question_type: question.question_type,
      question: question.question.trim(),
      options
    };
  });
}

function parseCorrectionFile(file, examNumber) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const corrections = [];
  let current = null;
  const headerPattern = /^\*\*(\d+)\.\s*([A-E](?:\s*,\s*[A-E])*)\.\*\*\s*(.*)$/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const header = line.match(headerPattern);
    if (header) {
      current = {
        test_number: examNumber,
        question_number: Number(header[1]),
        correct_options: [...new Set(header[2].toUpperCase().match(/[A-E]/g))].sort(),
        explanationLines: [cleanText(header[3])].filter(Boolean),
        referenceLines: []
      };
      corrections.push(current);
      continue;
    }
    if (!current) continue;
    if (/^##\s/.test(line) && !/^###/.test(line)) {
      current = null;
      continue;
    }
    if (!line) continue;
    const reference = line.match(/^\*?Référence\s*:\s*(.*?)\*?$/i);
    if (reference) current.referenceLines.push(cleanText(reference[1]));
    else current.explanationLines.push(cleanText(line));
  }

  return corrections.map(correction => {
    if (!correction.correct_options.length) {
      throw new Error(path.basename(file) + ' Q' + correction.question_number + ': réponse correcte introuvable');
    }
    return {
      test_number: correction.test_number,
      question_number: correction.question_number,
      correct_options: correction.correct_options,
      explanation: correction.explanationLines.filter(Boolean).join(' ').trim(),
      reference: correction.referenceLines.filter(Boolean).join(' ').trim()
    };
  });
}

function examData(examNumber) {
  const suffix = String(examNumber).padStart(2, '0');
  const stemFile = path.join(directory, 'UEI1_Examen_' + suffix + '.md');
  const correctionFile = path.join(directory, 'UEI1_Examen_' + suffix + '_Corrige.md');
  const indexFile = path.join(directory, 'UEI1_10_Examens_INDEX.md');
  const indexLines = fs.readFileSync(indexFile, 'utf8').split(/\r?\n/);
  const indexEntry = indexLines.find(line => new RegExp('^' + examNumber + '\\.\\s').test(line));
  const title = 'Examen ' + suffix + ' — UEI 1';
  const description = cleanText(indexEntry?.split('—').slice(1).join('—') || 'Examen blanc UEI 1');
  const questions = parseQuestionFile(stemFile, examNumber);
  const corrections = parseCorrectionFile(correctionFile, examNumber);
  const correctionByNumber = new Map(corrections.map(item => [item.question_number, item]));
  questions.forEach(question => {
    const correction = correctionByNumber.get(question.question_number);
    if (question.question_type === 'QCM' && correction?.correct_options.length > 1) {
      question.question_type = 'QCM à réponses multiples';
    }
  });

  if (questions.length !== 67 || corrections.length !== 67) {
    throw new Error(title + ': ' + questions.length + ' questions / ' + corrections.length + ' corrections (67 attendues)');
  }
  for (let index = 0; index < 67; index++) {
    const expected = index + 1;
    const question = questions[index];
    const correction = corrections[index];
    if (question.question_number !== expected || correction.question_number !== expected) {
      throw new Error(title + ': numérotation manquante ou désordonnée autour de la question ' + expected);
    }
    if (!question.question.trim() || !question.options.every(option => option.text.trim())) {
      throw new Error(title + ' Q' + expected + ': énoncé ou choix vide');
    }
    if (!correction.explanation) {
      throw new Error(title + ' Q' + expected + ': explication vide');
    }
  }
  return { test_number: examNumber, title, description, questions, corrections };
}

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function generateSql(exam) {
  const questionsJson = JSON.stringify(exam.questions.map(({ question_number, section, question_type, question, options }) => ({
    question_number, section, question_type, question, options
  })));
  const correctionsJson = JSON.stringify(exam.corrections.map(({ question_number, correct_options, explanation, reference }) => ({
    question_number, correct_options, explanation, reference
  })));
  return "begin;\n" +
    "with imported as (\n" +
    "  select * from jsonb_to_recordset(" + sqlString(questionsJson) + "::jsonb)\n" +
    "    as incoming(question_number integer, section text, question_type text, question text, options jsonb)\n" +
    ")\n" +
    "insert into public.dlmed_test_questions\n" +
    "  (test_number, question_number, section, question_type, question, options)\n" +
    "select " + exam.test_number + ", question_number, section, question_type, question, options\n" +
    "from imported\n" +
    "on conflict (test_number, question_number) do update set\n" +
    "  section = excluded.section,\n" +
    "  question_type = excluded.question_type,\n" +
    "  question = excluded.question,\n" +
    "  options = excluded.options;\n" +
    "with imported as (\n" +
    "  select * from jsonb_to_recordset(" + sqlString(correctionsJson) + "::jsonb)\n" +
    "    as incoming(question_number integer, correct_options jsonb, explanation text, reference text)\n" +
    ")\n" +
    "insert into public.dlmed_test_corrections\n" +
    "  (test_number, question_number, correct_options, explanation, reference)\n" +
    "select " + exam.test_number + ", question_number,\n" +
    "       array(select jsonb_array_elements_text(correct_options)),\n" +
    "       explanation, reference\n" +
    "from imported\n" +
    "on conflict (test_number, question_number) do update set\n" +
    "  correct_options = excluded.correct_options,\n" +
    "  explanation = excluded.explanation,\n" +
    "  reference = excluded.reference;\n" +
    "commit;";
}

if (mode === 'sql') {
  if (!onlyExam || onlyExam < 1 || onlyExam > 10) throw new Error('Use --exam 1..10 with --mode sql.');
  process.stdout.write(generateSql(examData(onlyExam)));
} else {
  const examNumbers = onlyExam ? [onlyExam] : Array.from({ length: 10 }, (_, index) => index + 1);
  const summaries = examNumbers.map(number => {
    const exam = examData(number);
    return {
      exam: number,
      title: exam.title,
      questions: exam.questions.length,
      corrections: exam.corrections.length,
      referenced: exam.corrections.filter(correction => correction.reference).length,
      questionTypes: [...new Set(exam.questions.map(question => question.question_type))]
    };
  });
  process.stdout.write(JSON.stringify(summaries, null, 2) + '\n');
}
