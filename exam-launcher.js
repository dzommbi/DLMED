(() => {
  'use strict';

  const launchButton = document.getElementById('startChosenExam');
  const errorNode = document.getElementById('examModuleError');
  const config = document.getElementById('examConfigModal');
  const beginButton = document.getElementById('beginChosenExam');
  if (!launchButton || !errorNode || !config) return;

  let closeTimer = 0;
  let selectedExamCount = null;

  function selectedLessons() {
    return window.DLMED_UI?.selectedLessons?.() || [];
  }

  function showError(message) {
    errorNode.textContent = message;
    errorNode.classList.remove('exam-error-shake');
    void errorNode.offsetWidth;
    errorNode.classList.add('exam-error-shake');
  }

  function closeConfig() {
    if (!config.classList.contains('open')) return;
    config.classList.remove('open');
    config.setAttribute('aria-hidden', 'true');
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      config.hidden = true;
      launchButton.focus();
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220);
  }

  async function reopenExamPickerFromReturnLink() {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get('mode') !== 'exam') return;
    const requestedIds = new Set((currentUrl.searchParams.get('lessons') || '')
      .split(',').map(value => value.trim()).filter(value => /^\d+$/.test(value)));
    if (requestedIds.size < 5) return;

    await (window.DLMED_AUTH?.authReady || Promise.resolve());
    if (!window.DLMED_AUTH?.isAuthorized()) return;
    await window.DLMED_UI?.initialize?.();
    if (!window.DLMED_AUTH?.isAuthorized()) return;

    // Open first: the picker refreshes its dynamic module rows when it opens.
    document.getElementById('openModulePicker')?.click();
    const inputs = [...document.querySelectorAll('.module-pick-check')];
    const matches = inputs.filter(input => requestedIds.has(String(input.dataset.lessonId)));
    if (matches.length < 5) {
      showError('Certains modules de cet examen ne sont plus disponibles. Sélectionne au moins cinq modules.');
      return;
    }

    matches.forEach(input => {
      input.checked = true;
      for (let parent = input.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches?.('details')) parent.open = true;
        if (parent.matches?.('.biochimie-lessons, .physiopathologie-lessons, .psychologie-lessons, .radiologie-lessons')) {
          parent.hidden = false;
          const toggle = document.querySelector(`[aria-controls="${parent.id}"]`);
          toggle?.setAttribute('aria-expanded', 'true');
        }
        if (parent.id === 'moduleModal') break;
      }
    });
    window.updateModulePicker?.();

    currentUrl.searchParams.delete('mode');
    currentUrl.searchParams.delete('lessons');
    history.replaceState(history.state, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
  }

  launchButton.addEventListener('click', async () => {
    errorNode.textContent = '';
    const chosen = selectedLessons();
    if (chosen.length < 5) {
      showError('Pour commencer un examen, sélectionne au moins 5 modules.');
      return;
    }
    if (!window.DLMED_AUTH?.isAuthorized() || !await window.DLMED_AUTH.ensureActiveSession()) return;

    const available = chosen.reduce((total, item) => total + (Number(item.count) || 0), 0);
    document.getElementById('examPoolSummary').textContent = `${chosen.length} modules · ${available} QCM disponibles`;
    config.querySelectorAll('[data-exam-count]').forEach(option => {
      const count = Number(option.dataset.examCount);
      option.disabled = available < count;
      option.querySelector('small').textContent = available < count ? 'Pas assez de QCM' : 'Questionnaire aléatoire';
      option.classList.remove('selected');
      option.setAttribute('aria-pressed', 'false');
    });
    selectedExamCount = null;
    beginButton.hidden = true;
    beginButton.disabled = true;
    document.getElementById('examPoolSummary').textContent = `${chosen.length} modules · ${available} QCM disponibles`;
    clearTimeout(closeTimer);
    config.hidden = false;
    config.classList.add('open');
    config.setAttribute('aria-hidden', 'false');
    config.querySelector('[data-exam-count]:not(:disabled)')?.focus();
  });

  config.querySelectorAll('[data-exam-count]').forEach(option => {
    option.addEventListener('click', () => {
      const count = Number(option.dataset.examCount);
      if (option.disabled) return;
      selectedExamCount = count;
      config.querySelectorAll('[data-exam-count]').forEach(choice => {
        const selected = choice === option;
        choice.classList.toggle('selected', selected);
        choice.setAttribute('aria-pressed', String(selected));
      });
      beginButton.hidden = false;
      beginButton.disabled = false;
      document.getElementById('examPoolSummary').textContent = `${count} QCM sélectionnés · clique sur Commencer pour lancer l’examen.`;
    });
  });

  beginButton.addEventListener('click', async () => {
    const chosen = selectedLessons();
    if (chosen.length < 5) {
      closeConfig();
      showError('Pour commencer un examen, sélectionne au moins 5 modules.');
      return;
    }
    const available = chosen.reduce((total, item) => total + (Number(item.count) || 0), 0);
    if (!selectedExamCount || available < selectedExamCount) return;
    if (!window.DLMED_AUTH?.isAuthorized() || !await window.DLMED_AUTH.ensureActiveSession()) return;
    const destination = new URL('./exam.html', window.location.href);
    destination.searchParams.set('lessons', chosen.map(item => item.lessonId).join(','));
    destination.searchParams.set('count', String(selectedExamCount));
    const attemptId = window.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    destination.searchParams.set('attempt', attemptId);
    window.location.assign(destination.href);
  });

  document.getElementById('closeExamConfig').addEventListener('click', closeConfig);
  config.addEventListener('click', event => { if (event.target === config) closeConfig(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && config.classList.contains('open')) closeConfig();
  });

  void reopenExamPickerFromReturnLink();
})();
