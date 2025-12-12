// ============================================
// SUPABASE KONFIGURATION
// ============================================
// WICHTIG: Credentials aus PROJEKT_ZUSAMMENFASSUNG.md
const SUPABASE_URL = 'https://fgvjxgcgbdzuewukxedo.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZndmp4Z2NnYmR6dWV3dWt4ZWRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ0MTE3MTksImV4cCI6MjA3OTk4NzcxOX0.DhWTfgz9nfpt1OHbUJiETWkIwVU4lk6FweEHZl0stDg'
const INSTALLATION_ID = 'braeuer-odermatt-staeheli-bremgarten'

// Supabase Client initialisieren
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

console.log('✅ Supabase connected:', SUPABASE_URL)

// ============================================
// DATA STORAGE & UTILITIES
// ============================================
let charges = [];
let paymentHistory = [];

// Globale Variablen für myStrom
let myStromInterval = null;
let currentSessionStartWs = null; // Speichert den Zählerstand (Watt-Sekunden) beim Start

let settings = {
    mode: 'simulation',
    priceHigh: 0.1668, 
    priceLow: 0.1606, 
    myStromIp: '', // Hier speichern wir die IP
    lastReset: null
};

// Formatierer für konsistente Ausgabe (Schweizer Locale)
const currencyFormatter = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numberFormatter = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFormatter = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });

// Bestimmt den Tarif basierend auf der Zeit (7-22 = high, 22-7 = low)
function getTariff(date) {
    const hour = date.getHours();
    if (hour >= 7 && hour < 22) {
        return { type: 'high', price: settings.priceHigh };
    } else {
        return { type: 'low', price: settings.priceLow };
    }
}

// Zentrale Funktion zur Berechnung der Details eines Ladevorgangs
function calculateChargeDetails(charge) {
    const date = new Date(charge.date);
    const tariffDetails = getTariff(date);
    
    const price = charge.price || tariffDetails.price; 
    const tariff = charge.tariff || tariffDetails.type;
    
    const cost = charge.kwh * price;
    const costPerParty = cost / 3;

    return { cost, costPerParty, price, tariff };
}

// ============================================
// MYSTROM INTEGRATION LOGIK
// ============================================

/**
 * Holt den Statusbericht vom myStrom Switch
 * API Endpoint: http://[IP]/report
 */
async function getMyStromReport() {
    const ip = settings.myStromIp;
    if (!ip) {
        alert('Bitte myStrom IP-Adresse in den Einstellungen eingeben!');
        return null;
    }

    try {
        // Hinweis: Der Browser könnte dies blockieren, wenn die Seite über HTTPS geladen wird
        // aber die IP lokal (http) ist. Im Heimnetzwerk funktioniert es meistens.
        const response = await fetch(`http://${ip}/report`);
        if (!response.ok) throw new Error('Keine Antwort vom Gerät');
        const data = await response.json();
        // Erwartetes Format: { power: 300, Ws: 123456, relay: true ... }
        return data; 
    } catch (error) {
        console.error('myStrom Fehler:', error);
        return null;
    }
}

async function testMyStromConnection() {
    // Nimmt den Wert direkt aus dem Input Feld für den Test
    const inputIp = document.getElementById('myStromIp').value;
    if(!inputIp) { alert('Bitte IP eingeben'); return; }
    
    // Temporär die IP nutzen für den Test
    const tempIp = settings.myStromIp;
    settings.myStromIp = inputIp;

    const data = await getMyStromReport();
    if (data) {
        alert(`✅ Verbindung erfolgreich!\nAktuelle Leistung: ${data.power} W\nZählerstand (Total): ${(data.Ws / 3600 / 1000).toFixed(3)} kWh`);
    } else {
        alert('❌ Verbindung fehlgeschlagen.\n\nPrüfe:\n1. Ist die IP korrekt?\n2. Bist du im gleichen WLAN?\n3. Browser-Sicherheit (Mixed Content).');
    }
    
    // Reset falls nicht gespeichert
    settings.myStromIp = tempIp;
}

async function startMyStromCharge() {
    const data = await getMyStromReport();
    if (!data) {
        alert('Konnte myStrom nicht erreichen. Bitte Verbindung prüfen.');
        return;
    }

    // 1. Startwert (Ws) speichern
    currentSessionStartWs = data.Ws;
    localStorage.setItem('myStromSessionStart', currentSessionStartWs);
    
    // 2. Optional: Switch einschalten (API: /relay?state=1)
    try { fetch(`http://${settings.myStromIp}/relay?state=1`); } catch(e){}

    // 3. UI umschalten
    toggleChargingUI(true);
    startMonitoring();
}

async function stopMyStromCharge() {
    if (!confirm('Ladevorgang beenden und Kosten speichern?')) return;

    const data = await getMyStromReport();
    if (!data) {
        alert('Fehler: Konnte Endwert nicht abrufen. Bitte manuell nachtragen oder Verbindung prüfen.');
        return;
    }

    const endWs = data.Ws;
    // Differenz berechnen
    const consumedWs = endWs - currentSessionStartWs;
    
    // Umrechnung: Watt-Sekunden -> kWh (1 kWh = 3.600.000 Ws)
    let kwh = consumedWs / 3600000;
    
    if (kwh < 0) {
        kwh = 0; // Fallback falls Zähler resettet wurde
        alert('Achtung: Zählerstand war kleiner als beim Start. Speichere 0 kWh.');
    }

    // Runden für Datenbank
    kwh = parseFloat(kwh.toFixed(4));

    // Optional: Switch ausschalten
    try { fetch(`http://${settings.myStromIp}/relay?state=0`); } catch(e){}

    // Speichern
    const now = new Date();
    const tariff = getTariff(now);
    
    const newCharge = {
        installation_id: INSTALLATION_ID,
        date: now.toISOString(),
        kwh: kwh,
        tariff: tariff.type,
        price: tariff.price
    };

    const { error } = await supabaseClient.from('charges').insert([newCharge]);

    if (error) {
        console.error('Supabase Error', error);
        alert('Fehler beim Speichern in die Datenbank!');
    } else {
        // Aufräumen
        localStorage.removeItem('myStromSessionStart');
        currentSessionStartWs = null;
        toggleChargingUI(false);
        stopMonitoring();
        
        // UI aktualisieren
        charges.unshift(newCharge);
        loadData();
        
        alert(`✅ Ladevorgang gespeichert!\nVerbrauch: ${kwh.toFixed(3)} kWh\nKosten: ${currencyFormatter.format(kwh * tariff.price)} CHF`);
    }
}

// Live-Monitoring Loop
function startMonitoring() {
    if (myStromInterval) clearInterval(myStromInterval);
    updateLiveStatus(); // Sofort einmal
    myStromInterval = setInterval(updateLiveStatus, 5000); // Alle 5 Sek
}

function stopMonitoring() {
    if (myStromInterval) clearInterval(myStromInterval);
    document.getElementById('currentPower').textContent = '0';
    document.getElementById('currentSessionKwh').textContent = '0.000';
}

async function updateLiveStatus() {
    const data = await getMyStromReport();
    if (data) {
        document.getElementById('currentPower').textContent = data.power.toFixed(1);
        
        if (currentSessionStartWs !== null) {
            const currentDiffWs = data.Ws - currentSessionStartWs;
            const kwh = Math.max(0, currentDiffWs / 3600000);
            document.getElementById('currentSessionKwh').textContent = kwh.toFixed(3);
        }
    }
}

function toggleChargingUI(isCharging) {
    const btnStart = document.getElementById('btnStartCharge');
    const btnStop = document.getElementById('btnStopCharge');
    const status = document.getElementById('liveStatus');

    if (isCharging) {
        btnStart.style.display = 'none';
        btnStop.style.display = 'inline-block';
        status.textContent = '⚡ LÄDT...';
        status.style.color = '#00ffc2';
        status.className = 'pulse-animation';
    } else {
        btnStart.style.display = 'inline-block';
        btnStop.style.display = 'none';
        status.textContent = 'Bereit';
        status.style.color = '#ccc';
        status.className = '';
    }
}

// ============================================
// AUTHENTIFIZIERUNG & STATUSVERWALTUNG
// ============================================

function toggleViews(isAuthenticated) {
    const appContainer = document.getElementById('appContainer');
    const authContainer = document.getElementById('authContainer');
    
    if (isAuthenticated) {
        appContainer.style.display = 'block';
        authContainer.style.display = 'none';
    } else {
        appContainer.style.display = 'none';
        authContainer.style.display = 'block';
    }
}

async function handleLogin() {
    const email = document.getElementById('emailInput').value;
    const password = document.getElementById('passwordInput').value;
    const errorDisplay = document.getElementById('authError');
    
    errorDisplay.style.display = 'none';
    
    const { error } = await supabaseClient.auth.signInWithPassword({
        email: email,
        password: password,
    });
    
    if (error) {
        errorDisplay.textContent = 'Anmeldung fehlgeschlagen. Überprüfen Sie E-Mail und Passwort.';
        errorDisplay.style.display = 'block';
    }
}

async function handleMagicLink() {
    const email = document.getElementById('emailInput').value;
    const errorDisplay = document.getElementById('authError');

    if (!email) {
        errorDisplay.textContent = 'Bitte geben Sie Ihre E-Mail-Adresse ein.';
        errorDisplay.style.display = 'block';
        return;
    }

    const { error } = await supabaseClient.auth.signInWithOtp({
        email: email,
    });

    if (error) {
        errorDisplay.textContent = 'Fehler beim Senden des Links.';
        errorDisplay.style.display = 'block';
    } else {
        alert('✅ Anmelde-Link gesendet! Bitte überprüfen Sie Ihr Postfach.');
    }
}

async function handleLogout() {
    if (confirm('Sicher, dass Sie sich abmelden möchten?')) {
        const { error } = await supabaseClient.auth.signOut();
        if (!error) {
            toggleViews(false);
            charges = [];
            paymentHistory = [];
        }
    }
}

// ============================================
// DATA HANDLING
// ============================================

async function loadData() {
    try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        
        if (!user) {
            toggleViews(false);
            return;
        }
        
        toggleViews(true); 
        
        // 1. Settings laden
        const savedSettings = localStorage.getItem('evSettings');
        if (savedSettings) {
            const parsed = JSON.parse(savedSettings);
            settings = { ...settings, ...parsed };
            document.getElementById('modeSelect').value = settings.mode;
            document.getElementById('priceHighInput').value = settings.priceHigh || 0.1668;
            document.getElementById('priceLowInput').value = settings.priceLow || 0.1606;
            document.getElementById('myStromIp').value = settings.myStromIp || ''; // IP Feld füllen
            
            // Check ob noch eine Session läuft (Browser Refresh)
            const savedSession = localStorage.getItem('myStromSessionStart');
            if (savedSession && settings.mode === 'live') {
                currentSessionStartWs = parseFloat(savedSession);
                updateModeDisplay(); // UI aktualisieren
                // Ein kleiner Delay damit UI da ist
                setTimeout(() => {
                    toggleChargingUI(true);
                    startMonitoring();
                }, 500);
            } else {
                updateModeDisplay();
            }
        }
        
        // 2. Ladevorgänge laden
        const { data: chargesData, error: chargesError } = await supabaseClient
            .from('charges')
            .select('*')
            .eq('installation_id', INSTALLATION_ID)
            .order('date', { ascending: false });
        
        if (chargesError) {
            console.error('Error loading charges:', chargesError);
        } else {
            charges = chargesData || [];
        }
        
        // 3. Zahlungen laden
        const { data: paymentsData, error: paymentsError } = await supabaseClient
            .from('payment_history')
            .select('*')
            .eq('installation_id', INSTALLATION_ID)
            .order('payment_date', { ascending: false });
        
        if (paymentsError) {
            console.error('Error loading payments:', paymentsError);
        } else {
            paymentHistory = paymentsData || [];
        }
        
        // Simulation Data falls leer
        if (settings.mode === 'simulation' && charges.length === 0) {
            await generateSimulationData();
        }
        
        updateDisplay();
        
    } catch (error) {
        console.error('Error in loadData:', error);
        toggleViews(false);
    }
}

async function saveData() {
    localStorage.setItem('evSettings', JSON.stringify(settings));
}

// Simulationsdaten generieren (unverändert)
async function generateSimulationData() {
    const today = new Date();
    const newCharges = [];
    
    for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
        const chargesPerDay = Math.floor(Math.random() * 3);
        
        for (let i = 0; i < chargesPerDay; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - daysAgo);
            
            if (i === 0) date.setHours(18 + Math.floor(Math.random() * 6));
            else date.setHours(7 + Math.floor(Math.random() * 6));
            date.setMinutes(Math.floor(Math.random() * 60));
            
            const kwh = (Math.random() * 10 + 10);
            const tariff = getTariff(date);
            
            newCharges.push({
                installation_id: INSTALLATION_ID,
                date: date.toISOString(),
                kwh: parseFloat(kwh.toFixed(2)),
                tariff: tariff.type,
                price: tariff.price
            });
        }
    }
    
    if (newCharges.length > 0) {
        const { data } = await supabaseClient.from('charges').insert(newCharges).select();
        if (data) charges = data.sort((a, b) => new Date(b.date) - new Date(a.date));
    }
}

// ============================================
// DISPLAY UPDATES
// ============================================

function updateDisplay() {
    updateStats();
    updateHistory();
    updateChart();
    updateMonthlyStats();
}

function updateStats() {
    const now = new Date();
    let relevantCharges = charges;
    if (settings.lastReset) {
        const resetDate = new Date(settings.lastReset);
        relevantCharges = charges.filter(c => new Date(c.date) > resetDate);
    }
    
    const totalKwh = relevantCharges.reduce((sum, c) => sum + c.kwh, 0);
    const totalCost = relevantCharges.reduce((sum, c) => sum + calculateChargeDetails(c).cost, 0);
    const costPerParty = totalCost / 3;
    
    document.getElementById('totalKwh').innerHTML = numberFormatter.format(totalKwh) + '<span class="stat-unit">kWh</span>';
    document.getElementById('totalCost').innerHTML = currencyFormatter.format(totalCost) + '<span class="stat-unit">CHF</span>';
    document.getElementById('chargeCount').textContent = relevantCharges.length;
    
    document.getElementById('brauerCost').innerHTML = currencyFormatter.format(costPerParty) + '<span class="stat-unit">CHF</span>';
    document.getElementById('odermattCost').innerHTML = currencyFormatter.format(costPerParty) + '<span class="stat-unit">CHF</span>';
    document.getElementById('staeheliCost').innerHTML = currencyFormatter.format(costPerParty) + '<span class="stat-unit">CHF</span>';
    
    const brauerStatus = document.getElementById('brauerStatus');
    const odermattStatus = document.getElementById('odermattStatus');
    const staeheliStatus = document.getElementById('staeheliStatus');
    
    if (costPerParty > 0.005) {
        brauerStatus.textContent = 'Ausstehend';
        brauerStatus.style.color = '#ff9999'; 
        odermattStatus.textContent = 'Ausstehend';
        odermattStatus.style.color = '#ff9999';
        staeheliStatus.textContent = 'Ausstehend';
        staeheliStatus.style.color = '#ff9999';
    } else {
        brauerStatus.textContent = 'Bezahlt ✓';
        brauerStatus.style.color = '#00ffc2';
        odermattStatus.textContent = 'Bezahlt ✓';
        odermattStatus.style.color = '#00ffc2';
        staeheliStatus.textContent = 'Bezahlt ✓';
        staeheliStatus.style.color = '#00ffc2';
    }
    
    if (settings.lastReset) {
        const resetDate = new Date(settings.lastReset);
        document.getElementById('lastResetDate').textContent = dateFormatter.format(resetDate);
        const daysDiff = Math.floor((now - resetDate) / (1000 * 60 * 60 * 24));
        document.getElementById('daysSinceReset').textContent = daysDiff;
    } else {
        document.getElementById('lastResetDate').textContent = 'Noch nie';
        document.getElementById('daysSinceReset').textContent = '-';
    }
    
    if (relevantCharges.length > 0) {
        const avgKwh = totalKwh / relevantCharges.length;
        const avgCost = totalCost / relevantCharges.length;
        document.getElementById('avgKwh').innerHTML = numberFormatter.format(avgKwh) + '<span class="stat-unit">kWh</span>';
        document.getElementById('avgCost').innerHTML = currencyFormatter.format(avgCost) + '<span class="stat-unit">CHF</span>';
        
        const last = relevantCharges[0];
        const lastDetails = calculateChargeDetails(last);
        const lastDate = new Date(last.date);
        document.getElementById('lastKwh').innerHTML = numberFormatter.format(last.kwh) + '<span class="stat-unit">kWh</span>';
        document.getElementById('lastCost').innerHTML = currencyFormatter.format(lastDetails.cost) + '<span class="stat-unit">CHF</span>';
        document.getElementById('lastDate').textContent = `${dateFormatter.format(lastDate)} ${timeFormatter.format(lastDate)}`;
    } else {
        document.getElementById('avgKwh').innerHTML = '- <span class="stat-unit">kWh</span>';
        document.getElementById('avgCost').innerHTML = '- <span class="stat-unit">CHF</span>';
        document.getElementById('lastKwh').innerHTML = '- <span class="stat-unit">kWh</span>';
        document.getElementById('lastCost').innerHTML = '- <span class="stat-unit">CHF</span>';
        document.getElementById('lastDate').textContent = '-';
    }

    return { totalKwh, totalCost, costPerParty, relevantChargesLength: relevantCharges.length };
}

function updateHistory() {
    const filteredCharges = charges;
    const tbody = document.getElementById('historyTable');
    
    if (filteredCharges.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-color-dark);">Keine Ladevorgänge vorhanden</td></tr>';
        return;
    }
    
    tbody.innerHTML = filteredCharges.map(c => {
        const date = new Date(c.date);
        const details = calculateChargeDetails(c);
        const tariffBadge = details.tariff === 'high' 
            ? '<span style="background: #ffcc00; color: #333; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; font-weight: 600;">HT</span>'
            : '<span style="background: #4a5568; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; font-weight: 600;">NT</span>';
        
        return `
            <tr>
                <td>${dateFormatter.format(date)}</td>
                <td>${timeFormatter.format(date)}</td>
                <td>${tariffBadge}</td>
                <td>${numberFormatter.format(c.kwh)}</td>
                <td>${numberFormatter.format(details.cost)}</td>
                <td>${numberFormatter.format(details.costPerParty)}</td>
            </tr>
        `;
    }).join('');
}

function updateMonthlyStats() {
    const tbody = document.getElementById('monthlyStatsTable');
    
    if (paymentHistory.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-color-dark);">Noch keine Zahlungen erfasst</td></tr>';
        document.getElementById('totalAllKwh').textContent = '0 kWh';
        document.getElementById('totalAllCost').textContent = '0.00 CHF';
        return;
    }
    
    const monthlyData = {};
    
    paymentHistory.forEach(payment => {
        const date = new Date(payment.payment_date || payment.date);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        if (!monthlyData[monthKey]) {
            monthlyData[monthKey] = {
                date: date,
                count: 0,
                totalKwh: 0,
                totalCost: 0
            };
        }
        
        monthlyData[monthKey].count++;
        monthlyData[monthKey].totalKwh += payment.total_kwh || payment.totalKwh || 0;
        monthlyData[monthKey].totalCost += payment.total_cost || payment.totalCost || 0;
    });
    
    const sortedMonths = Object.entries(monthlyData).sort((a, b) => b[1].date - a[1].date);
    let totalKwh = 0;
    let totalAllCost = 0;
    
    tbody.innerHTML = sortedMonths.map(([monthKey, data]) => {
        totalKwh += data.totalKwh;
        totalAllCost += data.totalCost;
        const monthName = data.date.toLocaleDateString('de-CH', { year: 'numeric', month: 'long' });
        
        return `
            <tr>
                <td>${monthName}</td>
                <td>${data.count}</td>
                <td>${numberFormatter.format(data.totalKwh)}</td>
                <td><strong>${currencyFormatter.format(data.totalCost)}</strong></td>
            </tr>
        `;
    }).join('');
    
    document.getElementById('totalAllKwh').textContent = numberFormatter.format(totalKwh) + ' kWh';
    document.getElementById('totalAllCost').textContent = currencyFormatter.format(totalAllCost) + ' CHF';
}

function updateChart() {
    const filteredCharges = charges; 
    const container = document.getElementById('chartContainer');
    const last7Days = [];
    const today = new Date();
    const filterEnd = today;
    filterEnd.setHours(0, 0, 0, 0);

    for (let i = 6; i >= 0; i--) {
        const date = new Date(filterEnd);
        date.setDate(filterEnd.getDate() - i);
        date.setHours(0, 0, 0, 0);
        
        const dayCharges = filteredCharges.filter(c => {
            const cd = new Date(c.date);
            cd.setHours(0, 0, 0, 0);
            return cd.getTime() === date.getTime();
        });
        
        const totalKwh = dayCharges.reduce((sum, c) => sum + c.kwh, 0);
        const totalCost = dayCharges.reduce((sum, c) => sum + calculateChargeDetails(c).cost, 0);
        
        last7Days.push({ date: date, kwh: totalKwh, cost: totalCost });
    }
    
    const maxKwh = Math.max(...last7Days.map(d => d.kwh), 1);
    
    container.innerHTML = last7Days.map(d => {
        const height = (d.kwh / maxKwh) * 100;
        const day = d.date.toLocaleDateString('de-DE', {weekday: 'short'});
        const kwhDisplay = d.kwh > 0 ? numberFormatter.format(d.kwh) + ' kWh' : '-';
        const costDisplay = d.cost > 0 ? currencyFormatter.format(d.cost) : '- CHF';

        return `
            <div class="chart-bar" style="height: ${height}%; position: relative;">
                <div style="position: absolute; top: -40px; left: 50%; transform: translateX(-50%); font-size: 0.75em; font-weight: 600; color: var(--primary-color); white-space: nowrap;">${kwhDisplay}</div>
                <div style="position: absolute; top: -25px; left: 50%; transform: translateX(-50%); font-size: 0.7em; color: var(--text-color-dark); white-space: nowrap;">${costDisplay}</div>
                <div class="chart-label">${day}</div>
            </div>
        `;
    }).join('');
}


// ============================================
// USER INTERACTIONS
// ============================================

async function saveSettings() {
    settings.mode = document.getElementById('modeSelect').value;
    settings.priceHigh = parseFloat(document.getElementById('priceHighInput').value);
    settings.priceLow = parseFloat(document.getElementById('priceLowInput').value);
    
    // myStrom IP speichern
    settings.myStromIp = document.getElementById('myStromIp').value;
    
    saveData();
    updateModeDisplay();
    updateDisplay();
    
    alert('✅ Einstellungen gespeichert!');
}

function updateModeDisplay() {
    const badge = document.getElementById('modeBadge');
    const myStromGroup = document.getElementById('myStromGroup');
    const liveControls = document.getElementById('liveChargingControls');
    
    if (settings.mode === 'simulation') {
        badge.className = 'mode-badge mode-simulation';
        badge.textContent = '🔄 Simulationsmodus';
        myStromGroup.style.display = 'none';
        liveControls.style.display = 'none';
        if(myStromInterval) clearInterval(myStromInterval);
    } else {
        badge.className = 'mode-badge mode-live';
        badge.textContent = '🟢 Live-Modus (myStrom)';
        myStromGroup.style.display = 'block';
        liveControls.style.display = 'block';
    }
}

async function addManualCharge() {
    const kwhStr = prompt('Verbrauch in kWh eingeben:');
    if (!kwhStr) return;
    
    const kwh = parseFloat(kwhStr);
    if (isNaN(kwh) || kwh <= 0) {
        alert('❌ Ungültige kWh-Eingabe.');
        return;
    }
    
    const timeStr = prompt('Uhrzeit eingeben (HH:MM, z.B. 14:30):\n(Leer lassen für aktuelle Zeit)');
    let chargeDate = new Date();
    
    if (timeStr && timeStr.trim() !== '') {
        const timeParts = timeStr.split(':');
        if (timeParts.length === 2) {
            const hours = parseInt(timeParts[0]);
            const minutes = parseInt(timeParts[1]);
            chargeDate.setHours(hours, minutes, 0, 0);
        }
    }
    
    const tariff = getTariff(chargeDate);
    
    const newCharge = {
        installation_id: INSTALLATION_ID,
        date: chargeDate.toISOString(),
        kwh: kwh,
        tariff: tariff.type,
        price: tariff.price
    };
    
    const { data, error } = await supabaseClient.from('charges').insert([newCharge]).select();
    
    if (error) {
        alert('❌ Fehler beim Speichern!');
    } else {
        charges.unshift(data[0]);
        updateDisplay();
    }
}

async function markAsPaid() {
    const stats = updateStats(); 
    const totalCost = stats.totalCost;
    
    if (stats.relevantChargesLength === 0 || totalCost < 0.005) {
        alert('ℹ️ Es gibt keine ausstehenden Kosten zum Bezahlen.');
        return;
    }
    
    if (confirm(`Betrag von CHF ${currencyFormatter.format(totalCost)} als bezahlt markieren und abrechnen?`)) {
        const newPayment = {
            installation_id: INSTALLATION_ID,
            payment_date: new Date().toISOString(),
            total_kwh: stats.totalKwh,
            total_cost: totalCost,
            cost_per_party: stats.costPerParty,
            charge_count: stats.relevantChargesLength
        };
        
        const { data, error } = await supabaseClient.from('payment_history').insert([newPayment]).select();
        
        if (!error) {
            paymentHistory.unshift(data[0]);
            settings.lastReset = new Date().toISOString();
            saveData();
            updateDisplay();
            alert('✅ Kosten als bezahlt markiert!');
        }
    }
}

async function resetData() {
    if (confirm('⚠️ Wirklich alle Daten löschen?')) {
        await supabaseClient.from('charges').delete().eq('installation_id', INSTALLATION_ID);
        await supabaseClient.from('payment_history').delete().eq('installation_id', INSTALLATION_ID);
        charges = [];
        paymentHistory = [];
        settings.lastReset = null;
        saveData();
        updateDisplay();
        alert('✅ Alle Daten wurden gelöscht!');
    }
}

// ============================================
// INITIALISIERUNG
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    loadData();
    document.getElementById('loginButton').addEventListener('click', handleLogin);
    document.getElementById('magicLinkButton').addEventListener('click', (e) => { e.preventDefault(); handleMagicLink(); });
    document.getElementById('passwordInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') handleLogin(); });

    supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN') loadData();
        else if (event === 'SIGNED_OUT') toggleViews(false);
    });
});

document.getElementById('modeSelect').addEventListener('change', function() {
    if (this.value === 'simulation' && charges.length === 0) {
        if (confirm('Möchten Sie Demo-Daten generieren?')) {
            generateSimulationData();
            updateDisplay();
        }
    }
});
