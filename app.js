const pageSize = 8;
let currentPage = 1;
let allResults = [];

const resultsList = document.getElementById('results-list');
const resultsCount = document.getElementById('results-count');
const status = document.getElementById('status');
const pageIndicator = document.getElementById('page-indicator');
const prevPageButton = document.getElementById('prev-page');
const nextPageButton = document.getElementById('next-page');
const refreshButton = document.getElementById('refresh-button');

function renderTenders(items) {
  resultsList.innerHTML = '';

  if (!items.length) {
    resultsList.innerHTML = '<li>No eligible tenders were found on this page.</li>';
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'tender-card';
    const fitScore = typeof item.fitScore === 'number' ? item.fitScore : null;
    const fitTier = fitScore === null ? '' : fitScore >= 70 ? 'fit-strong' : fitScore >= 45 ? 'fit-good' : fitScore >= 25 ? 'fit-possible' : 'fit-weak';

    li.innerHTML = `
      <div class="tender-title-block">
        <div><a href="${item.url}" target="_blank" rel="noreferrer">${item.title}</a></div>
        <div class="small-note">${item.source}</div>
        ${item.description ? `<div class="small-note tender-description">${item.description}</div>` : ''}
        ${item.fitSummary ? `<div class="small-note fit-summary">${item.fitSummary}</div>` : ''}
      </div>
      <div class="tender-meta-grid">
        <div class="meta-pill">
          <span>Type</span>
          <strong>${item.category || 'Eligibility match'}</strong>
        </div>
        ${fitScore === null ? '' : `
        <div class="meta-pill fit-pill ${fitTier}">
          <span>Malnus s.r.o. fit</span>
          <strong>${fitScore}% &middot; ${item.fitLabel}</strong>
        </div>`}
        <div class="meta-pill">
          <span>Deadline</span>
          <strong>${item.deadline || 'Not stated'}</strong>
        </div>
        <div class="meta-pill">
          <span>Potential funding</span>
          <strong>${item.fundingAmount || 'Not disclosed'}</strong>
        </div>
      </div>
    `;
    resultsList.appendChild(li);
  });
}

function renderPage() {
  const totalPages = Math.max(1, Math.ceil(allResults.length / pageSize));
  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;
  const pageItems = allResults.slice(start, end);

  pageIndicator.textContent = `Page ${currentPage} / ${totalPages}`;
  prevPageButton.disabled = currentPage <= 1;
  nextPageButton.disabled = currentPage >= totalPages;

  renderTenders(pageItems);
}

async function loadTenders() {
  status.textContent = 'Loading ESA STAR and EIC tenders filtered for Malnus s.r.o. eligibility...';
  resultsCount.textContent = 'Loading...';
  refreshButton.disabled = true;

  try {
    const response = await fetch('/api/tenders?query=space%20localization%20geospatial%20satellite%20ESA%20EIC%20horizon%20cassini%20services&country=Europe&limit=50');
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Search failed');
    }

    allResults = data.results || [];
    currentPage = 1;
    const totalCount = allResults.length;

    resultsCount.textContent = `${totalCount} found`;
    status.textContent = 'Showing ESA STAR (incl. Cassini) and EIC Funding Opportunities, filtered for Malnus s.r.o. relevance.';
    renderPage();
  } catch (error) {
    resultsCount.textContent = 'Error';
    status.textContent = error.message;
    resultsList.innerHTML = '<li>Unable to fetch live tender data right now.</li>';
  } finally {
    refreshButton.disabled = false;
  }
}

prevPageButton.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage -= 1;
    renderPage();
  }
});

nextPageButton.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(allResults.length / pageSize));
  if (currentPage < totalPages) {
    currentPage += 1;
    renderPage();
  }
});

refreshButton.addEventListener('click', () => {
  loadTenders();
});

loadTenders();

