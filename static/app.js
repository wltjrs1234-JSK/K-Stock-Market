// ==========================================================================
// [1. 상태 관리 및 설정]
// ==========================================================================
let watchlist = [
    { code: '005930', avgPrice: 0 },
    { code: '000660', avgPrice: 0 },
    { code: '005380', avgPrice: 0 },
    { code: '035720', avgPrice: 0 },
    { code: '035420', avgPrice: 0 }
]; // 기본값: 삼성전자, SK하이닉스, 현대차, 카카오, NAVER
let selectedStockCode = '005930'; // 현재 디테일 뷰에 활성화된 종목
let previousPrices = {}; // 가격 변동 감지용 이전 가격 캐시
const UPDATE_INTERVAL = 3000; // 3초 주기 폴링
let isEditingAvgPrice = false; // 평단가 수정 중 폴링 리렌더링 방지 플래그

// ApexCharts 인스턴스 관리용 글로벌 객체
let candleChart = null;
let volumeChart = null;
let rsiChart = null;
let isDraggingWatchlist = false; // 관심종목 드래그 정렬 시 폴링 일시중단용 플래그

// 서버로부터 관심종목 데이터 불러오기 (비동기)
async function loadWatchlistFromServer() {
    try {
        const res = await fetch('/api/watchlist');
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                watchlist = data;
                // 로컬스토리지 백업
                localStorage.setItem('watchlist', JSON.stringify(watchlist));
                
                // 첫 번째 종목 코드 설정
                if (watchlist.length > 0 && !selectedStockCode) {
                    selectedStockCode = watchlist[0].code;
                }
                return;
            }
        }
    } catch (e) {
        console.error("서버에서 관심종목 로드 실패, 로컬스토리지 시도:", e);
    }
    
    // 서버 조회 실패 혹은 데이터가 빌 경우 로컬스토리지에서 복구 시도
    if (localStorage.getItem('watchlist')) {
        try {
            const raw = JSON.parse(localStorage.getItem('watchlist'));
            if (Array.isArray(raw) && raw.length > 0) {
                watchlist = raw.map(item => {
                    if (typeof item === 'string') {
                        return { code: item, avgPrice: 0 };
                    } else if (item && typeof item === 'object' && item.code) {
                        return { code: item.code, avgPrice: Number(item.avgPrice) || 0 };
                    }
                    return null;
                }).filter(Boolean);
                
                if (watchlist.length > 0 && !selectedStockCode) {
                    selectedStockCode = watchlist[0].code;
                }
            }
        } catch (e) {
            console.error("로컬 관심종목 로드 에러:", e);
        }
    }
}

// 서버로 관심종목 데이터 전송 및 저장
async function saveWatchlistToServer() {
    try {
        // 로컬스토리지 백업
        localStorage.setItem('watchlist', JSON.stringify(watchlist));
        
        await fetch('/api/watchlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(watchlist)
        });
    } catch (e) {
        console.error("서버로 관심종목 저장 실패:", e);
    }
}


// ==========================================================================
// [2. 이벤트 바인딩 & 초기화]
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
    // 1. VS Code 행 번호 동적 생성
    generateLineNumbers();

    // 1.1 서버로부터 관심종목 리스트 및 평단가 동기화
    await loadWatchlistFromServer();

    // 2. 초기 데이터 즉시 갱신
    updateMarketSummary();
    updateWatchlistData();
    updateNews();
    if (selectedStockCode) {
        updateStockChart(selectedStockCode);
    }
    
    // 스플리터 레이아웃 바인딩
    initSplitterLayout();

    // 상단 지표 카드 클릭 시 차트 보기 이벤트 바인딩
    const indexCards = document.querySelectorAll('.index-trigger-card');
    indexCards.forEach(card => {
        card.addEventListener('click', () => {
            const code = card.getAttribute('data-code');
            if (code) {
                // 관심종목 테이블 행의 active 제거
                const rows = document.querySelectorAll('#watchlist-tbody tr');
                rows.forEach(r => r.classList.remove('active-row'));
                
                selectedStockCode = code;
                updateStockChart(code);
            }
        });
    });

    // 3. 주기적 타이머 시작 (3초)
    setInterval(() => {
        updateMarketSummary();
        if (!isEditingAvgPrice && !isDraggingWatchlist) {
            updateWatchlistData();
        }
    }, UPDATE_INTERVAL);

    // 4. 뉴스 주기적 타이머 시작 (30초)
    setInterval(updateNews, 30000);

    // 5. 종목 추가 폼 이벤트 및 자동완성 바인딩
    const addForm = document.getElementById('add-stock-form');
    const codeInput = document.getElementById('input-stock-code');
    const autocompleteList = document.getElementById('autocomplete-list');
    let debounceTimer = null;
    let currentFocus = -1; // 키보드 방향키 포커스 인덱스
    
    // 타이핑 감지 (디바운스 처리)
    codeInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        currentFocus = -1;
        const query = codeInput.value.trim();
        
        if (!query) {
            closeAutocomplete();
            return;
        }
        
        debounceTimer = setTimeout(() => {
            fetchAutocomplete(query);
        }, 200); // 200ms 디바운싱
    });
    
    // 키보드 내비게이션 (ArrowUp, ArrowDown, Enter, Escape)
    codeInput.addEventListener('keydown', (e) => {
        const items = autocompleteList.querySelectorAll('.autocomplete-item');
        if (items.length === 0) return;
        
        if (e.key === 'ArrowDown') {
            currentFocus++;
            setActive(items);
            e.preventDefault();
        } else if (e.key === 'ArrowUp') {
            currentFocus--;
            setActive(items);
            e.preventDefault();
        } else if (e.key === 'Enter') {
            if (currentFocus > -1) {
                // 키보드로 선택된 항목이 있다면 클릭 실행
                if (items[currentFocus]) {
                    items[currentFocus].click();
                }
                e.preventDefault();
            } else {
                // 선택된 항목이 없는데 그냥 Enter 친 경우, 첫 번째 추천 항목을 선택해서 추가
                if (items[0]) {
                    items[0].click();
                    e.preventDefault();
                }
            }
        } else if (e.key === 'Escape') {
            closeAutocomplete();
        }
    });

    function setActive(items) {
        if (!items) return;
        // 기존 active 제거
        items.forEach(item => item.classList.remove('active'));
        
        if (currentFocus >= items.length) currentFocus = 0;
        if (currentFocus < 0) currentFocus = items.length - 1;
        
        items[currentFocus].classList.add('active');
        // 스크롤 동기화
        items[currentFocus].scrollIntoView({ block: 'nearest' });
    }

    function closeAutocomplete() {
        autocompleteList.innerHTML = '';
        autocompleteList.classList.add('hidden');
    }

    async function fetchAutocomplete(query) {
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            if (!res.ok) return;
            const data = await res.json();
            
            autocompleteList.innerHTML = '';
            if (data.length === 0) {
                autocompleteList.classList.add('hidden');
                return;
            }
            
            data.forEach((stock) => {
                const div = document.createElement('div');
                div.className = 'autocomplete-item';
                div.innerHTML = `
                    <span class="stock-name">${stock.name}</span>
                    <span class="stock-code">${stock.code}</span>
                `;
                
                // 마우스 클릭 시 추가
                div.addEventListener('click', () => {
                    addStockToWatchlist(stock.code);
                    codeInput.value = '';
                    closeAutocomplete();
                });
                
                autocompleteList.appendChild(div);
            });
            
            autocompleteList.classList.remove('hidden');
        } catch (err) {
            console.error("Autocomplete fetch error:", err);
        }
    }
    
    // 외부 클릭 시 드롭다운 닫기
    document.addEventListener('click', (e) => {
        if (e.target !== codeInput && e.target !== autocompleteList) {
            closeAutocomplete();
        }
    });
    
    // 폼 서브밋 시 처리 (사용자가 임의로 타이핑하고 바로 추가 누를 때)
    addForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = codeInput.value.trim();
        
        // 6자리 숫자 코드이면 바로 추가
        if (query.length === 6 && /^\d+$/.test(query)) {
            addStockToWatchlist(query);
            codeInput.value = '';
            closeAutocomplete();
        } else {
            // 종목명인 경우, 드롭다운 첫 번째 항목을 추가
            const firstItem = autocompleteList.querySelector('.autocomplete-item');
            if (firstItem) {
                firstItem.click();
            } else {
                // 검색 결과도 없고 코드도 아니면 알림
                alert('유효한 종목명 또는 6자리 종목 코드를 입력해주세요.');
            }
        }
    });

    // 6. 스텔스 모드 토글 이벤트
    const btnStealthTrigger = document.getElementById('btn-stealth-trigger');
    const btnStealthRestore = document.getElementById('btn-stealth-restore');
    
    btnStealthTrigger.addEventListener('click', toggleStealthMode);
    btnStealthRestore.addEventListener('click', toggleStealthMode);

    // 단축키 이벤트 (ESC 키 누르면 토글)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            toggleStealthMode();
        }
    });
});

// VS Code 위장용 행 번호 생성
function generateLineNumbers() {
    const lineNumbersDiv = document.querySelector('.line-numbers');
    const codeBlock = document.getElementById('code-block');
    // 줄바꿈 개수로 라인 수 확인
    const linesCount = codeBlock.textContent.split('\n').length;
    
    lineNumbersDiv.innerHTML = '';
    for (let i = 1; i <= linesCount; i++) {
        const span = document.createElement('div');
        span.className = 'line-num';
        span.innerText = i;
        lineNumbersDiv.appendChild(span);
    }
}

// ==========================================================================
// [3. 스텔스 모드 제어]
// ==========================================================================
function toggleStealthMode() {
    const dashboardMode = document.getElementById('dashboard-mode');
    const stealthMode = document.getElementById('stealth-mode');
    
    if (stealthMode.classList.contains('hidden')) {
        dashboardMode.classList.add('hidden');
        stealthMode.classList.remove('hidden');
        document.title = "index.js - Stock_Project - Visual Studio Code"; // 브라우저 탭 타이틀까지 위장!
    } else {
        stealthMode.classList.add('hidden');
        dashboardMode.classList.remove('hidden');
        document.title = "K-Stock Dashboard";
    }
}

// ==========================================================================
// [4. 데이터 연동 (API Fetch)]
// ==========================================================================

// 4.1 종합 마켓 지표 업데이트 (코스피, 코스닥, 환율, 금)
async function updateMarketSummary() {
    try {
        const res = await fetch('/api/market-summary');
        if (!res.ok) throw new Error('Market Summary API Error');
        const data = await res.json();

        // UI 갱신 (지표 카드)
        renderIndexCard('kospi', data.kospi);
        renderIndexCard('kosdaq', data.kosdaq);
        renderIndexCard('exchange', data.exchange);
        renderIndexCard('nasdaq', data.nasdaq);
        renderIndexCard('wti', data.wti);
        renderIndexCard('gold', data.gold_dollar);

        // 스텔스 모드 내 변수 값 동기화 (상사에게 보이지 않는 깨알 위장)
        updateStealthIndex('kospi', data.kospi);
        updateStealthIndex('kosdaq', data.kosdaq);
        updateStealthIndex('exchange', data.exchange);

        // 마지막 업데이트 시각 표시
        const now = new Date();
        document.getElementById('last-update-time').innerText = 
            `실시간 갱신 중: ${now.toLocaleTimeString()}`;
            
    } catch (e) {
        console.error("지표 갱신 오류:", e);
    }
}

// 지표 카드 한 장 렌더링
function renderIndexCard(idPrefix, itemData) {
    if (!itemData) return;
    
    const priceEl = document.getElementById(`val-${idPrefix}-price`);
    const changeEl = document.getElementById(`val-${idPrefix}-change`);
    const rateEl = document.getElementById(`val-${idPrefix}-rate`);
    const cardEl = document.getElementById(`card-${idPrefix}`);

    if (!priceEl || !changeEl || !rateEl) return;

    priceEl.innerText = itemData.price;
    changeEl.innerText = (itemData.status === 'UP' ? '▲ ' : itemData.status === 'DOWN' ? '▼ ' : '') + itemData.change;
    rateEl.innerText = `${itemData.status === 'UP' ? '+' : ''}${itemData.rate}%`;

    // 변동 상태 스타일
    cardEl.className = 'summary-card';
    if (itemData.status === 'UP') {
        cardEl.classList.add('text-up');
    } else if (itemData.status === 'DOWN') {
        cardEl.classList.add('text-down');
    } else {
        cardEl.classList.add('text-same');
    }
}

// 스텔스 모드 코드 속 지수 바인딩
function updateStealthIndex(idPrefix, itemData) {
    if (!itemData) return;
    const stealthValEl = document.getElementById(`stealth-${idPrefix}`);
    const stealthChangeEl = document.getElementById(`stealth-${idPrefix}-change`);

    if (stealthValEl) {
        // 콤마 제거 후 소수로 파싱 가능하게 노출
        stealthValEl.innerText = itemData.price.replace(/,/g, '');
    }
    if (stealthChangeEl) {
        stealthChangeEl.innerText = `${itemData.status === 'UP' ? '+' : ''}${itemData.rate}%`;
        stealthChangeEl.className = 'stealth-c ' + (itemData.status === 'UP' ? 'text-up' : itemData.status === 'DOWN' ? 'text-down' : 'text-same');
    }
}

// 4.2 관심종목 데이터 업데이트
// 4.2 관심종목 데이터 업데이트
async function updateWatchlistData() {
    const tbody = document.getElementById('watchlist-tbody');
    const promises = watchlist.map(item => fetch(`/api/stock/${item.code}`).then(r => r.json()).catch(() => null));
    
    try {
        const results = await Promise.all(promises);
        
        // 종목 상세 뷰 정보 갱신 (선택된 종목이 있을 경우)
        let selectedStock = results.find(s => s && s.code === selectedStockCode);
        if (selectedStock) {
            renderStockDetails(selectedStock);
        } else if (['KOSPI', 'KOSDAQ', 'NASDAQ', 'USDKRW', 'OIL_CL', 'CMDT_GC'].includes(selectedStockCode)) {
            // 지수 정보 단독 조회 후 렌더링
            fetch(`/api/stock/${selectedStockCode}`)
                .then(r => r.json())
                .then(stockData => {
                    renderStockDetails(stockData);
                })
                .catch(err => console.error("Index detail fetch error:", err));
        }

        // 관심 종목 목록 테이블 렌더링
        tbody.innerHTML = '';
        results.forEach((stock, idx) => {
            if (!stock) return;
            
            const tr = document.createElement('tr');
            tr.setAttribute('draggable', 'true');
            tr.setAttribute('data-code', stock.code);
            if (stock.code === selectedStockCode) {
                tr.className = 'active-row';
            }
            
            const statusClass = stock.status === 'UP' ? 'text-up' : stock.status === 'DOWN' ? 'text-down' : 'text-same';
            const prefix = stock.status === 'UP' ? '▲' : stock.status === 'DOWN' ? '▼' : '';

            // 이전 가격과 비교하여 깜빡임 효과 적용
            const prevPrice = previousPrices[stock.code];
            let flashClass = '';
            if (prevPrice && prevPrice !== stock.price) {
                const prevPriceNum = parseFloat(prevPrice.replace(/,/g, ''));
                const currPriceNum = parseFloat(stock.price.replace(/,/g, ''));
                if (currPriceNum > prevPriceNum) {
                    flashClass = 'flash-up-anim';
                } else if (currPriceNum < prevPriceNum) {
                    flashClass = 'flash-down-anim';
                }
            }
            previousPrices[stock.code] = stock.price;

            // 평단가 정보 매핑
            const watchItem = watchlist.find(w => w.code === stock.code);
            const avgPrice = watchItem ? watchItem.avgPrice : 0;
            const currentPriceNum = parseFloat(stock.price.replace(/,/g, ''));
            
            let profitRateText = '-';
            let profitClass = 'text-same';
            
            if (avgPrice > 0) {
                const profitRate = ((currentPriceNum - avgPrice) / avgPrice) * 100;
                profitRateText = `${profitRate > 0 ? '+' : ''}${profitRate.toFixed(2)}%`;
                profitClass = profitRate > 0 ? 'text-up' : profitRate < 0 ? 'text-down' : 'text-same';
            }

            tr.innerHTML = `
                <td class="drag-handle"><i class="fa-solid fa-grip-lines"></i></td>
                <td><strong>${stock.name}</strong></td>
                <td><span class="stock-code">${stock.code}</span></td>
                <td class="stock-price ${statusClass} ${flashClass}">${stock.price}</td>
                <td class="stock-change-wrap ${statusClass}">${prefix} ${stock.change}</td>
                <td class="stock-change-wrap ${statusClass}">${stock.status === 'UP' ? '+' : ''}${stock.rate}%</td>
                <td class="avg-price-cell" data-code="${stock.code}" data-value="${avgPrice}">
                    ${avgPrice > 0 ? avgPrice.toLocaleString() : '클릭하여 입력'}
                </td>
                <td class="profit-rate-cell ${profitClass}">${profitRateText}</td>
                <td class="text-same">${stock.volume.toLocaleString()}</td>
                <td>
                    <button class="btn-delete" data-code="${stock.code}">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </td>
            `;

            // 클릭 시 디테일 및 차트 활성화
            tr.addEventListener('click', (e) => {
                if (e.target.closest('.btn-delete') || e.target.closest('.avg-price-cell') || e.target.closest('.drag-handle')) return;
                
                selectedStockCode = stock.code;
                updateWatchlistData(); 
                updateStockChart(stock.code); 
            });

            bindDragAndDropEvents(tr);
            tbody.appendChild(tr);

            // 삭제 버튼 바인딩
            const btnDel = tr.querySelector('.btn-delete');
            btnDel.addEventListener('click', () => {
                removeStockFromWatchlist(stock.code);
            });

            // 스텔스 모드 코드 변수 동기화
            if (idx < 5) {
                const stealthStockEl = document.getElementById(`stealth-stock-${idx}`);
                const stealthStockChangeEl = document.getElementById(`stealth-stock-change-${idx}`);
                
                if (stealthStockEl) {
                    stealthStockEl.innerText = stock.price.replace(/,/g, '');
                }
                if (stealthStockChangeEl) {
                    stealthStockChangeEl.innerText = `${stock.status === 'UP' ? '+' : ''}${stock.rate}% (${stock.name})`;
                    stealthStockChangeEl.className = 'stealth-c ' + (stock.status === 'UP' ? 'text-up' : stock.status === 'DOWN' ? 'text-down' : 'text-same');
                }
            }
        });

        // 인라인 평단가 에디터 바인딩
        bindAvgPriceEditor();

    } catch (e) {
        console.error("관심종목 갱신 오류:", e);
    }
}

// 관심 종목에 새로 추가
async function addStockToWatchlist(code) {
    const codes = watchlist.map(w => w.code);
    if (codes.includes(code)) {
        alert('이미 감시 목록에 등록되어 있는 종목 코드입니다.');
        return;
    }
    
    try {
        const res = await fetch(`/api/stock/${code}`);
        if (!res.ok) {
            alert('종목 정보를 찾을 수 없습니다. 올바른 국내 주식 코드인지 확인해 주세요.');
            return;
        }
        
        watchlist.push({ code, avgPrice: 0 });
        await saveWatchlistToServer();
        selectedStockCode = code; 
        updateWatchlistData();
        updateStockChart(code);
    } catch (e) {
        alert('서버 응답 오류로 종목을 추가할 수 없습니다.');
    }
}

// 관심 종목에서 삭제
function removeStockFromWatchlist(code) {
    watchlist = watchlist.filter(w => w.code !== code);
    saveWatchlistToServer();
    
    if (selectedStockCode === code) {
        selectedStockCode = watchlist.length > 0 ? watchlist[0].code : '';
    }
    
    updateWatchlistData();
    if (selectedStockCode) {
        updateStockChart(selectedStockCode);
    } else {
        clearStockCharts();
    }
}

// 평단가 인라인 에디팅 바인딩
function bindAvgPriceEditor() {
    const cells = document.querySelectorAll('.avg-price-cell');
    cells.forEach(cell => {
        cell.addEventListener('click', (e) => {
            if (cell.querySelector('input')) return;
            
            // 입력창 활성화 시 폴링 강제 리렌더링 중지
            isEditingAvgPrice = true;
            
            const code = cell.getAttribute('data-code');
            const currentVal = cell.getAttribute('data-value');
            
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'avg-price-input';
            input.value = currentVal === '0' ? '' : currentVal;
            
            cell.innerHTML = '';
            cell.appendChild(input);
            input.focus();
            
            let isSaved = false;
            const saveValue = () => {
                if (isSaved) return;
                isSaved = true;
                const newVal = Math.max(0, parseInt(input.value) || 0);
                updateAveragePrice(code, newVal);
                isEditingAvgPrice = false; // 플래그 해제
            };
            
            input.addEventListener('keydown', (evt) => {
                if (evt.key === 'Enter') {
                    saveValue();
                } else if (evt.key === 'Escape') {
                    isSaved = true;
                    isEditingAvgPrice = false; // 플래그 해제
                    updateWatchlistData(); 
                }
            });
            
            input.addEventListener('blur', saveValue);
        });
    });
}

// 평단가 정보 갱신
function updateAveragePrice(code, price) {
    const idx = watchlist.findIndex(w => w.code === code);
    if (idx !== -1) {
        watchlist[idx].avgPrice = price;
        saveWatchlistToServer();
        isEditingAvgPrice = false; // 플래그 최종 보장 해제
        updateWatchlistData();
        // 평단가가 갱신되면 차트의 평단가 선도 즉시 갱신
        if (selectedStockCode === code) {
            updateStockChart(code);
        }
    }
}

// 4.3 종목 세부정보 렌더링
function renderStockDetails(stock) {
    document.getElementById('detail-stock-name').innerText = stock.name;
    document.getElementById('detail-stock-code').innerText = stock.code;
    
    const priceEl = document.getElementById('detail-price');
    const rateEl = document.getElementById('detail-rate');
    const statusClass = stock.status === 'UP' ? 'text-up' : stock.status === 'DOWN' ? 'text-down' : 'text-same';
    
    priceEl.className = 'value ' + statusClass;
    priceEl.innerText = stock.price;
    
    rateEl.className = 'value ' + statusClass;
    rateEl.innerText = `${stock.status === 'UP' ? '+' : ''}${stock.rate}%`;
    
    document.getElementById('detail-open').innerText = stock.open;
    document.getElementById('detail-volume').innerText = stock.volume.toLocaleString();
    document.getElementById('detail-high').innerText = stock.high;
    document.getElementById('detail-low').innerText = stock.low;

    // MTS 모바일 차트 헤더 실시간 시세 연동
    const mtsTitle = document.getElementById('chart-stock-title');
    const mtsPrice = document.getElementById('mts-price-val');
    const mtsArrow = document.getElementById('mts-arrow-val');
    const mtsChange = document.getElementById('mts-change-val');
    const mtsRate = document.getElementById('mts-rate-val');
    const mtsPanel = document.getElementById('mts-price-panel-area');

    if (mtsTitle) mtsTitle.innerText = stock.name;
    if (mtsPrice) {
        mtsPrice.innerText = stock.price;
        mtsPrice.className = 'mts-current-price ' + statusClass;
    }
    if (mtsArrow) {
        mtsArrow.innerText = stock.status === 'UP' ? '▲' : stock.status === 'DOWN' ? '▼' : '';
        mtsArrow.className = 'mts-change-arrow ' + statusClass;
    }
    if (mtsChange) {
        mtsChange.innerText = stock.change;
        mtsChange.className = 'mts-change-price ' + statusClass;
    }
    if (mtsRate) {
        mtsRate.innerText = `${stock.status === 'UP' ? '+' : ''}${stock.rate}%`;
        mtsRate.className = 'mts-change-rate ' + statusClass;
    }
    if (mtsPanel) {
        mtsPanel.className = 'mts-price-panel ' + statusClass;
    }
}

// 4.4 주요 실시간 뉴스 업데이트
async function updateNews() {
    try {
        const res = await fetch('/api/news');
        if (!res.ok) throw new Error('News API Error');
        const newsList = await res.json();
        
        if (!newsList || newsList.length === 0) return;

        // 1. 헤더 가로 스크롤 뉴스 롤링 배너 업데이트
        const ticker = document.getElementById('news-ticker');
        ticker.innerHTML = '';
        newsList.forEach(news => {
            const item = document.createElement('a');
            item.className = 'ticker-item';
            item.href = news.link;
            item.target = '_blank';
            item.innerText = news.title;
            ticker.appendChild(item);
        });

        // 2. 우측 뉴스 보드 업데이트
        const newsBoardList = document.getElementById('news-board-list');
        if (newsBoardList) {
            newsBoardList.innerHTML = '';
            newsList.forEach(news => {
                const li = document.createElement('li');
                li.className = 'news-item';
                li.innerHTML = `<a href="${news.link}" target="_blank">${news.title}</a>`;
                newsBoardList.appendChild(li);
            });
        }

        // 3. 스텔스 모드 터미널에 최신 뉴스 한 줄 위장 표시
        const stealthNewsLine = document.getElementById('stealth-news-line');
        if (stealthNewsLine && newsList.length > 0) {
            stealthNewsLine.innerText = `uvicorn main:app --reload (최신 뉴스: ${newsList[0].title})`;
        }
    } catch (e) {
        console.error("뉴스 업데이트 실패:", e);
    }
}

// ==========================================================================
// [4.5 상하단 스플리터 드래그 크기 조절]
// ==========================================================================
function initSplitterLayout() {
    // 1. 상하 수평 스플리터
    const splitterH = document.getElementById('layout-splitter');
    const topPanel = document.querySelector('.main-content-top');
    if (splitterH && topPanel) {
        splitterH.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startTopHeight = topPanel.offsetHeight;
            
            const onMouseMoveH = (moveEvent) => {
                const deltaY = moveEvent.clientY - startY;
                const newTopHeight = startTopHeight + deltaY;
                
                // 상단 높이 최소 180px 및 최대 800px 제한
                if (newTopHeight > 180 && newTopHeight < 800) {
                    topPanel.style.height = `${newTopHeight}px`;
                    window.dispatchEvent(new Event('resize'));
                }
            };
            
            const onMouseUpH = () => {
                document.removeEventListener('mousemove', onMouseMoveH);
                document.removeEventListener('mouseup', onMouseUpH);
                window.dispatchEvent(new Event('resize'));
            };
            
            document.addEventListener('mousemove', onMouseMoveH);
            document.addEventListener('mouseup', onMouseUpH);
        });
    }

    // 2. 좌우 수직 스플리터
    const splitterV = document.getElementById('layout-splitter-vertical');
    const bottomLeft = document.getElementById('bottom-left-chart-wrapper');
    const bottomPanel = document.querySelector('.main-content-bottom');
    if (splitterV && bottomLeft && bottomPanel) {
        splitterV.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startLeftWidth = bottomLeft.offsetWidth;
            const parentWidth = bottomPanel.offsetWidth;
            
            const onMouseMoveV = (moveEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const newLeftWidth = startLeftWidth + deltaX;
                const newLeftPercent = (newLeftWidth / parentWidth) * 100;
                
                // 차트 영역 가로 비율 제한 (최소 30%, 최대 85%)
                if (newLeftPercent > 30 && newLeftPercent < 85) {
                    bottomLeft.style.width = `${newLeftPercent}%`;
                    window.dispatchEvent(new Event('resize'));
                }
            };
            
            const onMouseUpV = () => {
                document.removeEventListener('mousemove', onMouseMoveV);
                document.removeEventListener('mouseup', onMouseUpV);
                window.dispatchEvent(new Event('resize'));
            };
            
            document.addEventListener('mousemove', onMouseMoveV);
            document.addEventListener('mouseup', onMouseUpV);
        });
    }
}

// ==========================================================================
// [5. 실시간 차트 업데이트 및 렌더러 (ApexCharts)]
// ==========================================================================
async function updateStockChart(code) {
    if (!code) {
        clearStockCharts();
        return;
    }
    
    // ApexCharts 로딩 대기
    if (typeof ApexCharts === 'undefined') {
        console.warn("ApexCharts is not loaded yet. Retrying in 300ms...");
        setTimeout(() => updateStockChart(code), 300);
        return;
    }
    
    const placeholder = document.getElementById('chart-placeholder');
    const panesWrapper = document.getElementById('chart-panes-wrapper');
    const titleEl = document.getElementById('chart-stock-title');
    
    try {
        const res = await fetch(`/api/stock/${code}/chart`);
        if (!res.ok) throw new Error("Chart data fetch failed");
        const chartData = await res.json();
        
        if (!chartData || chartData.length === 0) {
            clearStockCharts();
            return;
        }
        
        // 종목명 매핑
        const stockRes = await fetch(`/api/stock/${code}`).catch(() => null);
        const stockName = stockRes && stockRes.ok ? (await stockRes.json()).name : code;
        if (titleEl) {
            titleEl.innerText = `${stockName} (${code}) 일봉 차트`;
        }
        
        // UI 전환 (차트 보임)
        if (placeholder) placeholder.classList.add('hidden');
        if (panesWrapper) panesWrapper.classList.remove('hidden');
        
        // 브라우저 Reflow 대응 지연 호출
        setTimeout(() => {
            renderChartsActual(chartData, stockName, code);
        }, 50);
        
    } catch (err) {
        console.error("Chart load error:", err);
        clearStockCharts();
    }
}

// 실제 ApexCharts 렌더링 실행
// 헬퍼 함수: MTS용 동적 어노테이션 생성
function getMtsAnnotations(startIndex, endIndex, uniqueChartData, avgPrice, currentStock) {
    const annotations = {
        yaxis: [],
        xaxis: [],
        points: []
    };

    // 1. 내 평단가 기준선 (존재하는 경우)
    if (avgPrice > 0) {
        annotations.yaxis.push({
            y: avgPrice,
            borderColor: '#f59e0b',
            borderWidth: 1.5,
            strokeDashArray: 4,
            label: {
                borderColor: '#f59e0b',
                style: {
                    color: '#ffffff',
                    background: '#f59e0b',
                    fontSize: '10px',
                    fontWeight: 700
                },
                text: `내 평단: ${avgPrice.toLocaleString()}원`
            }
        });
    }

    // 2. 현재가 기준선 및 Y축 말풍선
    if (currentStock) {
        const currentPriceNum = parseFloat(currentStock.price.replace(/,/g, ''));
        const statusColor = currentStock.status === 'UP' ? '#ef4444' : currentStock.status === 'DOWN' ? '#3b82f6' : '#94a3b8';
        annotations.yaxis.push({
            y: currentPriceNum,
            borderColor: statusColor,
            borderWidth: 1.5,
            strokeDashArray: 2,
            label: {
                borderColor: statusColor,
                style: {
                    color: '#ffffff',
                    background: statusColor,
                    fontSize: '10px',
                    fontWeight: 700
                },
                text: `${currentStock.price} (${currentStock.status === 'UP' ? '+' : ''}${currentStock.rate}%)`
            }
        });
    }

    // 3. 뷰포트 내 최고가 / 최저가 실시간 포인터 추적
    if (uniqueChartData.length > 0 && startIndex < uniqueChartData.length) {
        const viewportData = uniqueChartData.slice(startIndex, endIndex + 1);
        if (viewportData.length > 0) {
            let highest = viewportData[0];
            let lowest = viewportData[0];
            
            viewportData.forEach(item => {
                if (item.high > highest.high) highest = item;
                if (item.low < lowest.low) lowest = item;
            });
            
            const baseClose = viewportData[0].close;
            const highestRate = (((highest.high - baseClose) / baseClose) * 100).toFixed(2);
            const lowestRate = (((lowest.low - baseClose) / baseClose) * 100).toFixed(2);
            
            const highestDateFormatted = highest.time.substring(2).replace(/-/g, '.');
            const lowestDateFormatted = lowest.time.substring(2).replace(/-/g, '.');
            
            // 최고점 포인트 어노테이션
            annotations.points.push({
                x: new Date(highest.time).getTime(),
                y: highest.high,
                marker: {
                    size: 4,
                    fillColor: '#ef4444',
                    strokeColor: '#fff',
                    radius: 2
                },
                label: {
                    borderColor: '#ef4444',
                    style: {
                        color: '#fff',
                        background: '#ef4444',
                        fontSize: '9px',
                        fontWeight: '700'
                    },
                    text: `▲ ${highest.high.toLocaleString()} (${highestDateFormatted}) +${highestRate}%`,
                    offsetY: -15
                }
            });
            
            // 최저점 포인트 어노테이션
            annotations.points.push({
                x: new Date(lowest.time).getTime(),
                y: lowest.low,
                marker: {
                    size: 4,
                    fillColor: '#3b82f6',
                    strokeColor: '#fff',
                    radius: 2
                },
                label: {
                    borderColor: '#3b82f6',
                    style: {
                        color: '#fff',
                        background: '#3b82f6',
                        fontSize: '9px',
                        fontWeight: '700'
                    },
                    text: `▼ ${lowest.low.toLocaleString()} (${lowestDateFormatted}) ${lowestRate}%`,
                    offsetY: 15
                }
            });
        }
    }

    // 4. RSI 강세약세 세로 음영 구간 계산
    let inStrong = false;
    let strongStart = null;
    let inWeak = false;
    let weakStart = null;

    uniqueChartData.forEach((item, idx) => {
        const t = new Date(item.time).getTime();
        const rsiVal = item.rsi;

        if (rsiVal !== null && rsiVal !== undefined) {
            // 강세 (RSI >= 70)
            if (rsiVal >= 70) {
                if (!inStrong) {
                    inStrong = true;
                    strongStart = t;
                }
            } else {
                if (inStrong) {
                    inStrong = false;
                    annotations.xaxis.push({
                        x: strongStart,
                        x2: t,
                        fillColor: 'rgba(239, 68, 68, 0.08)',
                        opacity: 0.8,
                        borderWidth: 0
                    });
                }
            }

            // 약세 (RSI <= 30)
            if (rsiVal <= 30) {
                if (!inWeak) {
                    inWeak = true;
                    weakStart = t;
                }
            } else {
                if (inWeak) {
                    inWeak = false;
                    annotations.xaxis.push({
                        x: weakStart,
                        x2: t,
                        fillColor: 'rgba(59, 130, 246, 0.08)',
                        opacity: 0.8,
                        borderWidth: 0
                    });
                }
            }
        }
    });

    if (inStrong && strongStart) {
        annotations.xaxis.push({
            x: strongStart,
            x2: new Date(uniqueChartData[uniqueChartData.length - 1].time).getTime(),
            fillColor: 'rgba(239, 68, 68, 0.08)',
            opacity: 0.8,
            borderWidth: 0
        });
    }
    if (inWeak && weakStart) {
        annotations.xaxis.push({
            x: weakStart,
            x2: new Date(uniqueChartData[uniqueChartData.length - 1].time).getTime(),
            fillColor: 'rgba(59, 130, 246, 0.08)',
            opacity: 0.8,
            borderWidth: 0
        });
    }

    return annotations;
}

// 실제 ApexCharts 렌더링 실행
async function renderChartsActual(chartData, stockName, code) {
    const candlePane = document.getElementById('chart-pane-candle');
    const volumePane = document.getElementById('chart-pane-volume');
    const rsiPane = document.getElementById('chart-pane-rsi');
    
    if (!candlePane || !volumePane || !rsiPane) return;
    
    // 너비 확정 대기
    if (candlePane.clientWidth === 0) {
        setTimeout(() => renderChartsActual(chartData, stockName, code), 50);
        return;
    }
    
    try {
        // 기존 인스턴스 깔끔히 제거
        if (candleChart) { candleChart.destroy(); candleChart = null; }
        if (volumeChart) { volumeChart.destroy(); volumeChart = null; }
        if (rsiChart) { rsiChart.destroy(); rsiChart = null; }
        
        // 중복 제거 및 시간순 정렬
        const seenTimes = new Set();
        const uniqueChartData = [];
        chartData.forEach(item => {
            if (item && item.time && !seenTimes.has(item.time)) {
                seenTimes.add(item.time);
                uniqueChartData.push(item);
            }
        });
        uniqueChartData.sort((a, b) => new Date(a.time) - new Date(b.time));
        
        const len = uniqueChartData.length;
        const defaultWindowSize = 60;
        const startIndex = Math.max(0, len - defaultWindowSize);
        
        const minTime = len > 0 ? new Date(uniqueChartData[startIndex].time).getTime() : null;
        const maxTime = len > 0 ? new Date(uniqueChartData[len - 1].time).getTime() : null;

        // 최신 종목 정보 조회 (현재가 및 등락률 축 어노테이션용)
        const currentStock = await fetch(`/api/stock/${code}`).then(r => r.json()).catch(() => null);
        
        // 해당 종목의 평단가 조회
        const watchItem = watchlist.find(w => w.code === code);
        const avgPrice = watchItem ? watchItem.avgPrice : 0;

        // MTS용 동적 어노테이션 로드
        const candleAnnotations = getMtsAnnotations(startIndex, len - 1, uniqueChartData, avgPrice, currentStock);
        
        const candleData = [];
        const sma5Data = [];
        const sma10Data = [];
        const sma20Data = [];
        const sma60Data = [];
        const sma120Data = [];
        const volumeData = [];
        const rsiData = [];
        const rsiSignalData = [];
        
        uniqueChartData.forEach(item => {
            const timestamp = new Date(item.time).getTime();
            
            // 1. 캔들스틱 [Open, High, Low, Close]
            candleData.push({
                x: timestamp,
                y: [item.open, item.high, item.low, item.close]
            });
            
            // 2. 이동평균선
            if (item.sma5 !== null && item.sma5 !== undefined) {
                sma5Data.push({ x: timestamp, y: item.sma5 });
            }
            if (item.sma10 !== null && item.sma10 !== undefined) {
                sma10Data.push({ x: timestamp, y: item.sma10 });
            }
            if (item.sma20 !== null && item.sma20 !== undefined) {
                sma20Data.push({ x: timestamp, y: item.sma20 });
            }
            if (item.sma60 !== null && item.sma60 !== undefined) {
                sma60Data.push({ x: timestamp, y: item.sma60 });
            }
            if (item.sma120 !== null && item.sma120 !== undefined) {
                sma120Data.push({ x: timestamp, y: item.sma120 });
            }
            
            // 3. 거래량 (상승 빨강, 하락 파랑 개별 색상 바인딩)
            const vColor = item.close >= item.open ? 'rgba(239, 68, 68, 0.6)' : 'rgba(59, 130, 246, 0.6)';
            volumeData.push({
                x: timestamp,
                y: item.volume,
                fillColor: vColor
            });
            
            // 4. RSI 및 RSI Signal
            if (item.rsi !== null && item.rsi !== undefined) {
                rsiData.push({ x: timestamp, y: item.rsi });
            }
            if (item.rsi_signal !== null && item.rsi_signal !== undefined) {
                rsiSignalData.push({ x: timestamp, y: item.rsi_signal });
            }
        });
        
        // 공통 테마 설정
        const darkThemeColor = '#64748b';
        const gridColor = 'rgba(0, 0, 0, 0.04)';
        
        // 1. 캔들 및 이평선 차트 셋업 (1단)
        const candleOptions = {
            chart: {
                id: 'candle-chart',
                group: 'stock-charts',
                type: 'line',
                height: 380,
                toolbar: { show: false },
                animations: { enabled: false },
                foreColor: darkThemeColor
            },
            dataLabels: {
                enabled: false
            },
            series: [
                { name: '일봉', type: 'candlestick', data: candleData },
                { name: '5일선', type: 'line', data: sma5Data },
                { name: '10일선', type: 'line', data: sma10Data },
                { name: '20일선', type: 'line', data: sma20Data },
                { name: '60일선', type: 'line', data: sma60Data },
                { name: '120일선', type: 'line', data: sma120Data }
            ],
            stroke: {
                width: [1, 1.2, 1.2, 1.2, 1.2, 1.2],
                curve: 'smooth'
            },
            colors: ['#ef4444', '#ef4444', '#ec4899', '#f59e0b', '#10b981', '#3b82f6'],
            plotOptions: {
                candlestick: {
                    colors: {
                        upward: '#ef4444',
                        downward: '#3b82f6'
                    },
                    wick: { useFillColor: true }
                }
            },
            xaxis: {
                type: 'datetime',
                min: minTime,
                max: maxTime,
                labels: { show: false },
                axisBorder: { show: false },
                axisTicks: { show: false }
            },
            yaxis: {
                labels: {
                    formatter: (v) => v ? Math.round(v).toLocaleString() : ''
                }
            },
            annotations: candleAnnotations,
            grid: {
                borderColor: gridColor
            },
            tooltip: {
                theme: 'light',
                shared: true,
                x: { format: 'yyyy-MM-dd' }
            }
        };
        
        // 2. 거래량 차트 셋업 (2단)
        const volumeOptions = {
            chart: {
                id: 'volume-chart',
                group: 'stock-charts',
                type: 'bar',
                height: 180,
                toolbar: { show: false },
                animations: { enabled: false },
                foreColor: darkThemeColor
            },
            dataLabels: {
                enabled: false
            },
            series: [
                { name: '거래량', data: volumeData }
            ],
            xaxis: {
                type: 'datetime',
                min: minTime,
                max: maxTime,
                labels: { show: false },
                axisBorder: { show: false },
                axisTicks: { show: false }
            },
            yaxis: {
                labels: {
                    formatter: (v) => {
                        if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
                        if (v >= 1000) return (v / 1000).toFixed(0) + 'K';
                        return v ? v.toLocaleString() : '0';
                    }
                }
            },
            annotations: {
                yaxis: volumeData.length > 0 ? [{
                    y: volumeData[volumeData.length - 1].y,
                    borderColor: 'transparent',
                    label: {
                        borderColor: '#64748b',
                        style: {
                            color: '#ffffff',
                            background: '#64748b',
                            fontSize: '9px',
                            fontWeight: 700
                        },
                        text: (volumeData[volumeData.length - 1].y >= 1000000)
                            ? (volumeData[volumeData.length - 1].y / 1000000).toFixed(1) + 'M'
                            : (volumeData[volumeData.length - 1].y / 1000).toFixed(0) + 'K'
                    }
                }] : []
            },
            grid: {
                borderColor: gridColor
            },
            tooltip: {
                theme: 'light',
                x: { format: 'yyyy-MM-dd' }
            }
        };
        
        // 3. RSI 차트 셋업 (3단)
        const rsiOptions = {
            chart: {
                id: 'rsi-chart',
                group: 'stock-charts',
                type: 'line',
                height: 180,
                toolbar: { show: false },
                animations: { enabled: false },
                foreColor: darkThemeColor
            },
            dataLabels: {
                enabled: false
            },
            series: [
                { name: 'RSI(14)', data: rsiData },
                { name: 'Signal(9)', data: rsiSignalData }
            ],
            stroke: {
                width: [1.5, 1.2],
                curve: 'smooth'
            },
            colors: ['#0f172a', '#ef4444'],
            xaxis: {
                type: 'datetime',
                min: minTime,
                max: maxTime,
                labels: {
                    style: { fontSize: '9px' },
                    format: 'MM-dd'
                },
                axisBorder: { color: 'rgba(0, 0, 0, 0.08)' },
                axisTicks: { color: 'rgba(0, 0, 0, 0.08)' }
            },
            yaxis: {
                min: 0,
                max: 100,
                tickAmount: 4,
                labels: {
                    formatter: (v) => v !== undefined && v !== null ? v.toFixed(0) : ''
                }
            },
            annotations: {
                yaxis: [
                    {
                        y: 70,
                        y2: 100,
                        borderColor: 'transparent',
                        fillColor: '#fee2e2',
                        opacity: 0.35,
                        label: {
                            style: { color: '#ef4444', background: '#ffffff', fontSize: '9px', fontWeight: 700 },
                            text: '70.0'
                        }
                    },
                    {
                        y: 0,
                        y2: 30,
                        borderColor: 'transparent',
                        fillColor: '#e0f2fe',
                        opacity: 0.35,
                        label: {
                            style: { color: '#3b82f6', background: '#ffffff', fontSize: '9px', fontWeight: 700 },
                            text: '30.0'
                        }
                    }
                ]
            },
            grid: {
                borderColor: gridColor
            },
            tooltip: {
                theme: 'light',
                x: { format: 'yyyy-MM-dd' }
            }
        };
        
        // 차트 렌더링
        candleChart = new ApexCharts(candlePane, candleOptions);
        candleChart.render();
        
        volumeChart = new ApexCharts(volumePane, volumeOptions);
        volumeChart.render();
        
        rsiChart = new ApexCharts(rsiPane, rsiOptions);
        rsiChart.render();
        
        // 4. 스크롤바 슬라이더 초기화 및 동적 연동
        const slider = document.getElementById('chart-timeline-slider');
        const minDateLabel = document.getElementById('scrollbar-min-date');
        const maxDateLabel = document.getElementById('scrollbar-max-date');

        if (slider && minDateLabel && maxDateLabel && len > 0) {
            const maxSliderVal = Math.max(0, len - defaultWindowSize);
            slider.min = 0;
            slider.max = maxSliderVal;
            slider.value = maxSliderVal; // 디폴트는 가장 최근 구간

            // 초기 라벨 텍스트 지정 (최근 60일 구간)
            minDateLabel.innerText = uniqueChartData[startIndex].time;
            maxDateLabel.innerText = uniqueChartData[len - 1].time;

            // 슬라이더 조절 시 줌 범위 및 최고/최저가 어노테이션 갱신
            slider.oninput = () => {
                const val = parseInt(slider.value);
                const currentStartIndex = val;
                const currentEndIndex = Math.min(len - 1, val + defaultWindowSize - 1);

                const slideMin = new Date(uniqueChartData[currentStartIndex].time).getTime();
                const slideMax = new Date(uniqueChartData[currentEndIndex].time).getTime();

                // 날짜 라벨 실시간 갱신
                minDateLabel.innerText = uniqueChartData[currentStartIndex].time;
                maxDateLabel.innerText = uniqueChartData[currentEndIndex].time;

                // 최고/최저가 및 현재가 어노테이션 실시간 계산
                const updatedAnnotations = getMtsAnnotations(
                    currentStartIndex,
                    currentEndIndex,
                    uniqueChartData,
                    avgPrice,
                    currentStock
                );

                // 캔들차트 줌인 및 어노테이션 동적 갱신
                if (candleChart) {
                    candleChart.updateOptions({
                        xaxis: {
                            min: slideMin,
                            max: slideMax
                        },
                        annotations: updatedAnnotations
                    }, false, false);
                }

                // 거래량차트 개별 줌 적용 (동기화 전파 시 Y축 눈금 및 가격 뱃지 겹침 방지)
                if (volumeChart) {
                    volumeChart.updateOptions({
                        xaxis: {
                            min: slideMin,
                            max: slideMax
                        }
                    }, false, false);
                }

                // RSI차트 개별 줌 적용 (동기화 전파 시 Y축 눈금 및 가격 뱃지 겹침 방지)
                if (rsiChart) {
                    rsiChart.updateOptions({
                        xaxis: {
                            min: slideMin,
                            max: slideMax
                        }
                    }, false, false);
                }
            };
        }
        
        // 스텔스 모드 동기화
        const lastItem = uniqueChartData[uniqueChartData.length - 1];
        if (lastItem) {
            updateStealthIndicators(lastItem);
        }
        
    } catch (err) {
        console.error("Chart load error:", err);
        clearStockCharts();
    }
}

// 차트 초기화 및 인스턴스 파괴
function clearStockCharts() {
    if (candleChart) { candleChart.destroy(); candleChart = null; }
    if (volumeChart) { volumeChart.destroy(); volumeChart = null; }
    if (rsiChart) { rsiChart.destroy(); rsiChart = null; }
    
    const placeholder = document.getElementById('chart-placeholder');
    const panesWrapper = document.getElementById('chart-panes-wrapper');
    const titleEl = document.getElementById('chart-stock-title');
    
    if (placeholder) placeholder.classList.remove('hidden');
    if (panesWrapper) panesWrapper.classList.add('hidden');
    if (titleEl) titleEl.innerText = "종목 선택 필요";
}

// 스텔스 모드 및 실제 UI 보조지표 동기화
function updateStealthIndicators(lastItem) {
    // 실제 UI 주가 패널의 RSI 값 실시간 동기화
    const detailRsiEl = document.getElementById('detail-rsi');
    if (detailRsiEl) {
        if (lastItem && lastItem.rsi !== null && lastItem.rsi !== undefined) {
            const rsi = lastItem.rsi;
            detailRsiEl.innerText = rsi.toFixed(2);
            detailRsiEl.className = 'value'; // 기본 클래스
            if (rsi >= 70) {
                detailRsiEl.classList.add('text-up');
            } else if (rsi <= 30) {
                detailRsiEl.classList.add('text-down');
            } else {
                detailRsiEl.classList.add('text-same');
            }
        } else {
            detailRsiEl.innerText = '-';
            detailRsiEl.className = 'value text-same';
        }
    }

    const rsiValEl = document.getElementById('stealth-rsi-value');
    const rsiStatusEl = document.getElementById('stealth-rsi-status');
    const macdValEl = document.getElementById('stealth-macd-value');
    const macdStatusEl = document.getElementById('stealth-macd-status');
    
    if (rsiValEl && lastItem.rsi !== null && lastItem.rsi !== undefined) {
        const rsi = lastItem.rsi;
        rsiValEl.innerText = rsi.toFixed(1);
        if (rsiStatusEl) {
            if (rsi >= 70) {
                rsiStatusEl.innerText = '"OVERBOUGHT"';
                rsiValEl.className = 'stealth-c text-up';
            } else if (rsi <= 30) {
                rsiStatusEl.innerText = '"OVERSOLD"';
                rsiValEl.className = 'stealth-c text-down';
            } else {
                rsiStatusEl.innerText = '"NEUTRAL"';
                rsiValEl.className = 'stealth-c text-same';
            }
        }
    }
    
    if (macdValEl && lastItem.macd_hist !== null && lastItem.macd_hist !== undefined) {
        const hist = lastItem.macd_hist;
        macdValEl.innerText = hist.toFixed(1);
        if (macdStatusEl) {
            if (hist > 0) {
                macdStatusEl.innerText = '"BUY_SIGNAL"';
                macdValEl.className = 'stealth-c text-up';
            } else {
                macdStatusEl.innerText = '"SELL_SIGNAL"';
                macdValEl.className = 'stealth-c text-down';
            }
        }
    }
}

// ==========================================================================
// [9. 관심종목 드래그 앤 드롭 정렬]
// ==========================================================================
let dragSrcEl = null;

function bindDragAndDropEvents(tr) {
    tr.addEventListener('dragstart', (e) => {
        isDraggingWatchlist = true;
        dragSrcEl = tr;
        tr.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tr.getAttribute('data-code'));
    });

    tr.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        
        const targetTr = e.target.closest('tr');
        if (targetTr && targetTr !== dragSrcEl) {
            const rect = targetTr.getBoundingClientRect();
            const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
            const tbody = targetTr.parentNode;
            tbody.insertBefore(dragSrcEl, next ? targetTr.nextSibling : targetTr);
        }
    });

    tr.addEventListener('dragenter', (e) => {
        const targetTr = e.target.closest('tr');
        if (targetTr && targetTr !== dragSrcEl) {
            targetTr.classList.add('drag-over');
        }
    });

    tr.addEventListener('dragleave', (e) => {
        const targetTr = e.target.closest('tr');
        if (targetTr) {
            targetTr.classList.remove('drag-over');
        }
    });

    tr.addEventListener('drop', (e) => {
        e.preventDefault();
        const targetTr = e.target.closest('tr');
        if (targetTr) {
            targetTr.classList.remove('drag-over');
        }
    });

    tr.addEventListener('dragend', () => {
        tr.classList.remove('dragging');
        const rows = document.querySelectorAll('#watchlist-tbody tr');
        rows.forEach(r => r.classList.remove('drag-over'));
        isDraggingWatchlist = false;
        
        // DOM 순서를 바탕으로 watchlist 배열 재정렬 및 로컬스토리지 저장
        reorderWatchlistFromDOM();
    });
}

function reorderWatchlistFromDOM() {
    const tbody = document.getElementById('watchlist-tbody');
    const rows = tbody.querySelectorAll('tr');
    const newWatchlist = [];
    
    rows.forEach(row => {
        const code = row.getAttribute('data-code');
        if (code) {
            const existingItem = watchlist.find(item => item.code === code);
            if (existingItem) {
                newWatchlist.push(existingItem);
            }
        }
    });
    
    if (newWatchlist.length > 0) {
        watchlist = newWatchlist;
        saveWatchlistToServer();
    }
}

