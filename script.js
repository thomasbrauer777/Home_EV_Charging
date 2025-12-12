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
let settings = {
    mode: 'simulation',
    priceHigh: 0.1668, 
    priceLow: 0.1606, 
    shellyModel: '',   
    shellyIp: '',
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
// AUTHENTIFIZIERUNG & STATUSVERWALTUNG
// ============================================

/**
 * Zeigt die App-Oberfläche oder die Login-Seite, basierend auf dem Anmeldestatus.
 * @param {boolean} isAuthenticated 
 */
function toggleViews(isAuthenticated) {
    const appContainer = document.getElementById('appContainer');
    const authContainer = document.getElementById('authContainer');
    
    if (isAuthenticated) {
        appContainer.style.display = 'block';
        authContainer.style.display = 'none';
        console.log('✅ Benutzer angemeldet. App-Inhalt sichtbar.');
    } else {
        appContainer.style.display = 'none';
        authContainer.style.display = 'block';
        console.log('❌ Benutzer abgemeldet. Login-Seite sichtbar.');
    }
}

/**
 * Meldet den Benutzer mit E-Mail und Passwort an.
 */
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
        console.error('Login-Fehler:', error.message);
        errorDisplay.textContent = 'Anmeldung fehlgeschlagen. Überprüfen Sie E-Mail und Passwort.';
        errorDisplay.style.display = 'block';
    }
}

/**
 * Sendet einen Magic Link an die E-Mail-Adresse.
 */
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
        console.error('Magic Link Fehler:', error.message);
        errorDisplay.textContent = 'Fehler beim Senden des Links. Ist die E-Mail korrekt?';
        errorDisplay.style.display = 'block';
    } else {
        alert('✅ Anmelde-Link gesendet! Bitte überprüfen Sie Ihr Postfach.');
    }
}

/**
 * Meldet den Benutzer ab.
 */
async function handleLogout() {
    if (confirm('Sicher, dass Sie sich abmelden möchten?')) {
        const { error } = await supabaseClient.auth.signOut();
        
        if (error) {
            console.error('Logout-Fehler:', error.message);
            alert('❌ Fehler beim Abmelden!');
        } else {
            toggleViews(false);
            // Nach dem Logout die Daten zurücksetzen
            charges = [];
            paymentHistory = [];
            updateDisplay();
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
        
        const savedSettings = localStorage.getItem('evSettings');
        if (savedSettings) {
            const parsed = JSON.parse(savedSettings);
            settings = { ...settings, ...parsed };
            document.getElementById('modeSelect').value = settings.mode;
            document.getElementById('priceHighInput').value = settings.priceHigh || 0.1668;
            document.getElementById('priceLowInput').value = settings.priceLow || 0.1606;
            document.getElementById('shellyModel').value = settings.shellyModel || '';
            document.getElementById('shellyIp').value = settings.shellyIp || '';
            updateModeDisplay();
        }
        
        const { data: chargesData, error: chargesError } = await supabaseClient
            .from('charges')
            .select('*')
            .eq('installation_id', INSTALLATION_ID)
            .order('date', { ascending: false });
        
        if (chargesError) {
            console.error('Error loading charges:', chargesError);
        } else {
            charges = chargesData || [];
            console.log(`Loaded ${charges.length} charges from Supabase`);
        }
        
        const { data: paymentsData, error: paymentsError } = await supabaseClient
            .from('payment_history')
            .select('*')
            .eq('installation_id', INSTALLATION_ID)
            .order('payment_date', { ascending: false });
        
        if (paymentsError) {
            console.error('Error loading payments:', paymentsError);
        } else {
            paymentHistory = paymentsData || [];
            console.log(`Loaded ${paymentHistory.length} payments from Supabase`);
        }
        
        if (settings.mode === 'simulation' && charges.length === 0) {
            await generateSimulationData();
            await generateDemoPaymentHistory();
        }
        
        updateDisplay();
        
    } catch (error) {
        console.error('Error in loadData:', error);
        toggleViews(false);
        alert('Fehler beim Laden der Daten. Bitte überprüfe deine Supabase-Konfiguration oder den Login-Status.');
    }
}

async function generateDemoPaymentHistory() {
    const now = new Date();
    const newPayments = [];
    const numPayments = 3;
    
    for (let i = 0; i < numPayments; i++) {
        const paymentDate = new Date(now);
        paymentDate.setMonth(paymentDate.getMonth() - (i + 1));
        
        const numCharges = Math.floor(Math.random() * 10) + 8;
        const totalKwh = (Math.random() * 100 + 150);
        const avgPrice = (settings.priceHigh + settings.priceLow) / 2;
        const totalCost = parseFloat(totalKwh) * avgPrice;
        const costPerParty = totalCost / 3;
        
        newPayments.push({
            installation_id: INSTALLATION_ID,
            payment_date: paymentDate.toISOString(),
            total_kwh: totalKwh,
            total_cost: totalCost,
            cost_per_party: costPerParty,
            charge_count: numCharges
        });
    }
    
    if (newPayments.length > 0) {
        const { data, error } = await supabaseClient
            .from('payment_history')
            .insert(newPayments)
            .select();
        
        if (error) {
            console.error('Error saving demo payments:', error);
        } else {
            paymentHistory = data.sort((a, b) => new Date(b.payment_date) - new Date(a.payment_date));
            console.log(`✅ Generated ${paymentHistory.length} demo payments`);
        }
    }
}

async function saveData() {
    localStorage.setItem('evSettings', JSON.stringify(settings));
}

async function generateSimulationData() {
    const today = new Date();
    const newCharges = [];
    
    for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
        const chargesPerDay = Math.floor(Math.random() * 3);
        
        for (let i = 0; i < chargesPerDay; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - daysAgo);
            
            if (i === 0) {
                date.setHours(18 + Math.floor(Math.random() * 6));
            } else {
                date.setHours(7 + Math.floor(Math.random() * 6));
            }
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
        const { data, error } = await supabaseClient
            .from('charges')
            .insert(newCharges)
            .select();
        
        if (error) {
            console.error('Error saving simulation data:', error);
        } else {
            charges = data.sort((a, b) => new Date(b.date) - new Date(a.date));
            console.log(`✅ Generated ${charges.length} demo charges`);
        }
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
    // KEIN FILTER: Zeigt alle Ladevorgänge
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
    
    const sortedMonths = Object.entries(monthlyData)
        .sort((a, b) => b[1].date - a[1].date);
    
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
    // KEIN FILTER: Wird nur für die letzten 7 Tage berechnet (wie ursprünglich)
    const filteredCharges = charges; 
    const container = document.getElementById('chartContainer');
    const last7Days = [];
    const today = new Date();
    
    // Basis ist heute
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
        
        last7Days.push({
            date: date,
            kwh: totalKwh,
            cost: totalCost
        });
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
    settings.shellyModel = document.getElementById('shellyModel').value;
    settings.shellyIp = document.getElementById('shellyIp').value;
    
    saveData();
    updateModeDisplay();
    updateDisplay();
    
    let message = '✅ Einstellungen gespeichert!';
    if (settings.mode === 'live' && settings.shellyModel) {
        const modelNames = {
            'plug-s': 'Shelly Plug S (Gen1)',
            'plug-s-plus': 'Shelly Plus Plug S (Gen2)',
            '3em': 'Shelly 3EM (Gen1)',
            'pro-3em': 'Shelly Pro 3EM (Gen2)',
            '1pm': 'Shelly 1PM (Gen1)',
            'plus-1pm': 'Shelly Plus 1PM (Gen2)'
        };
        message += '\n\nModell: ' + modelNames[settings.shellyModel];
    }
    
    alert(message);
}

function updateModeDisplay() {
    const badge = document.getElementById('modeBadge');
    const shellyModelGroup = document.getElementById('shellyModelGroup');
    const shellyGroup = document.getElementById('shellyIpGroup');
    
    if (settings.mode === 'simulation') {
        badge.className = 'mode-badge mode-simulation';
        badge.textContent = '🔄 Simulationsmodus';
        shellyModelGroup.style.display = 'none';
        shellyGroup.style.display = 'none';
    } else {
        badge.className = 'mode-badge mode-live';
        badge.textContent = '🟢 Live-Modus';
        shellyModelGroup.style.display = 'block';
        shellyGroup.style.display = 'block';
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
            if (!isNaN(hours) && !isNaN(minutes) && hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
                chargeDate.setHours(hours, minutes, 0, 0);
            } else {
                alert('❌ Ungültiges Zeitformat (erwartet HH:MM). Nutze aktuelle Zeit.');
            }
        } else {
             alert('❌ Ungültiges Zeitformat (erwartet HH:MM). Nutze aktuelle Zeit.');
        }
    }
    
    const tariff = getTariff(chargeDate);
    const tariffName = tariff.type === 'high' ? 'Hochtarif (Tag)' : 'Niedertarif (Nacht)';
    
    const newCharge = {
        installation_id: INSTALLATION_ID,
        date: chargeDate.toISOString(),
        kwh: kwh,
        tariff: tariff.type,
        price: tariff.price
    };
    
    const { data, error } = await supabaseClient
        .from('charges')
        .insert([newCharge])
        .select();
    
    if (error) {
        console.error('Error saving charge:', error);
        alert('❌ Fehler beim Speichern!');
    } else {
        charges.unshift(data[0]);
        updateDisplay();
        alert(`✅ Ladevorgang hinzugefügt!\nTarif: ${tariffName} (${numberFormatter.format(tariff.price)} CHF/kWh)`);
    }
}

async function markAsPaid() {
    const stats = updateStats(); 
    const totalKwh = stats.totalKwh;
    const totalCost = stats.totalCost;
    const costPerParty = stats.costPerParty;
    
    if (stats.relevantChargesLength === 0 || totalCost < 0.005) {
        alert('ℹ️ Es gibt keine ausstehenden Kosten zum Bezahlen.');
        return;
    }
    
    const message = `Folgende Beträge als bezahlt markieren?\n\n` +
                   `Familie Bräuer: CHF ${currencyFormatter.format(costPerParty)}\n` +
                   `Familie Odermatt: CHF ${currencyFormatter.format(costPerParty)}\n` +
                   `Familie Stäheli: CHF ${currencyFormatter.format(costPerParty)}\n\n` +
                   `Gesamt: CHF ${currencyFormatter.format(totalCost)} (${numberFormatter.format(totalKwh)} kWh)\n\n` +
                   `Die Zahlung wird in der Gesamtkosten-Übersicht gespeichert.`;
    
    if (confirm(message)) {
        const newPayment = {
            installation_id: INSTALLATION_ID,
            payment_date: new Date().toISOString(),
            total_kwh: totalKwh,
            total_cost: totalCost,
            cost_per_party: costPerParty,
            charge_count: stats.relevantChargesLength
        };
        
        const { data, error } = await supabaseClient
            .from('payment_history')
            .insert([newPayment])
            .select();
        
        if (error) {
            console.error('Error saving payment:', error);
            alert('❌ Fehler beim Speichern der Zahlung!');
        } else {
            paymentHistory.unshift(data[0]);
            
            settings.lastReset = new Date().toISOString();
            saveData();
            updateDisplay();
            alert('✅ Kosten als bezahlt markiert und in Gesamtkosten-Übersicht gespeichert!\n\nDer Abrechnungszeitraum wurde zurückgesetzt.');
        }
    }
}

async function resetData() {
    if (confirm('⚠️ Wirklich alle Daten löschen? Dies löscht auch die Gesamtkosten-Übersicht! Dies kann nicht rückgängig gemacht werden!')) {
        try {
            const { error: chargesError } = await supabaseClient
                .from('charges')
                .delete()
                .eq('installation_id', INSTALLATION_ID);
            
            if (chargesError) throw chargesError;
            
            const { error: paymentsError } = await supabaseClient
                .from('payment_history')
                .delete()
                .eq('installation_id', INSTALLATION_ID);
            
            if (paymentsError) throw paymentsError;
            
            charges = [];
            paymentHistory = [];
            settings.lastReset = null;
            
            if (settings.mode === 'simulation') {
                await generateSimulationData();
                await generateDemoPaymentHistory();
            }
            
            saveData();
            updateDisplay();
            
            if (settings.mode === 'simulation') {
                alert('✅ Alle Daten wurden zurückgesetzt und neue Demo-Daten generiert!');
            } else {
                alert('✅ Alle Daten wurden gelöscht!');
            }
        } catch (error) {
            console.error('Error resetting data:', error);
            alert('❌ Fehler beim Löschen der Daten!');
        }
    }
}
// ============================================
// MYSTROM INTEGRATION
// ============================================

let myStromInterval = null;
let currentSessionStartWs = null; // Startwert in Watt-Sekunden

// Einstellungen aktualisieren (Shelly raus, myStrom rein)
function updateModeDisplay() {
    const badge = document.getElementById('modeBadge');
    const myStromGroup = document.getElementById('myStromGroup');
    const liveControls = document.getElementById('liveChargingControls');
    
    // UI Elemente anzeigen/verstecken
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
        
        // Prüfen ob bereits eine Session läuft (aus LocalStorage wiederherstellen)
        const savedStart = localStorage.getItem('myStromSessionStart');
        if (savedStart) {
            currentSessionStartWs = parseFloat(savedStart);
            toggleChargingUI(true);
            startMonitoring();
        }
    }
}

// Verbindung testen und aktuellen Wert holen
async function getMyStromReport() {
    const ip = document.getElementById('myStromIp').value || settings.shellyIp; // Fallback auf altes Feld
    if (!ip) {
        alert('Bitte IP-Adresse eingeben!');
        return null;
    }

    try {
        // Der Trick bei myStrom: /report liefert JSON mit 'power' (Watt) und 'Ws' (Watt-Sekunden)
        const response = await fetch(`http://${ip}/report`);
        if (!response.ok) throw new Error('Keine Antwort');
        const data = await response.json();
        return data; // Erwartet: { power: 300, Ws: 123456, relay: true ... }
    } catch (error) {
        console.error('myStrom Fehler:', error);
        return null;
    }
}

async function testMyStromConnection() {
    const data = await getMyStromReport();
    if (data) {
        alert(`✅ Verbindung erfolgreich!\nAktuelle Leistung: ${data.power} W\nZählerstand: ${(data.Ws / 3600 / 1000).toFixed(3)} kWh`);
    } else {
        alert('❌ Verbindung fehlgeschlagen. \n\n1. Prüfe die IP.\n2. Bist du im gleichen WLAN?\n3. Browser blockiert evtl. lokale Anfragen (Mixed Content).');
    }
}

// Startet den Ladevorgang
async function startMyStromCharge() {
    const data = await getMyStromReport();
    if (!data) {
        alert('Konnte myStrom nicht erreichen. Prüfe IP.');
        return;
    }

    // Wir merken uns den Zählerstand (Ws) beim Start
    currentSessionStartWs = data.Ws;
    localStorage.setItem('myStromSessionStart', currentSessionStartWs);
    
    // Optional: Switch einschalten via API
    try { fetch(`http://${settings.shellyIp}/relay?state=1`); } catch(e){}

    toggleChargingUI(true);
    startMonitoring();
}

// Beendet den Ladevorgang und speichert in Supabase
async function stopMyStromCharge() {
    if (confirm('Ladevorgang beenden und abrechnen?')) {
        const data = await getMyStromReport();
        if (!data) {
            alert('Fehler: Konnte Endwert nicht abrufen. Bitte manuell nachtragen.');
            return;
        }

        const endWs = data.Ws;
        const consumedWs = endWs - currentSessionStartWs;
        
        // Umrechnung: Watt-Sekunden -> kWh
        // 1 kWh = 3.600.000 Ws
        let kwh = consumedWs / 3600000;
        
        // Sicherheits-Check falls Zähler zurückgesetzt wurde (z.B. Stromausfall)
        if (kwh < 0) {
            alert('Achtung: Der Zählerstand ist kleiner als beim Start (evtl. Reset?). Speichere als 0.');
            kwh = 0;
        }

        // Runden auf 3 Stellen
        kwh = Math.round(kwh * 1000) / 1000;

        // In Supabase speichern (nutzt existierende Logik)
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
            alert('Fehler beim Speichern!');
        } else {
            // UI Reset
            localStorage.removeItem('myStromSessionStart');
            currentSessionStartWs = null;
            toggleChargingUI(false);
            stopMonitoring();
            
            // Daten neu laden
            charges.unshift(newCharge); // Schnell-Update für UI
            loadData(); // Sauberes Neuladen
            
            alert(`✅ Geladen: ${kwh.toFixed(3)} kWh\nKosten: ${currencyFormatter.format(kwh * tariff.price)} CHF`);
        }
    }
}

// Überwachungsschleife für Live-Anzeige
function startMonitoring() {
    if (myStromInterval) clearInterval(myStromInterval);
    
    // Sofort einmal ausführen
    updateLiveStatus();

    // Alle 5 Sekunden aktualisieren
    myStromInterval = setInterval(updateLiveStatus, 5000);
}

function stopMonitoring() {
    if (myStromInterval) clearInterval(myStromInterval);
    document.getElementById('currentPower').textContent = '0';
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
        status.textContent = '⚡ Lädt...';
        status.style.color = '#00ffc2'; // Green
        status.className = 'pulse-animation'; // Optional CSS class
    } else {
        btnStart.style.display = 'inline-block';
        btnStop.style.display = 'none';
        status.textContent = 'Bereit';
        status.style.color = '#ccc';
        status.className = '';
    }
}
// ============================================
// INITIALISIERUNG & EVENT-LISTENERS
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    // Initialer Ladevorgang
    loadData();

    // Event Listener für den Anmelde-Button
    document.getElementById('loginButton').addEventListener('click', handleLogin);

    // Event Listener für "Magic Link"
    document.getElementById('magicLinkButton').addEventListener('click', (e) => {
        e.preventDefault();
        handleMagicLink();
    });

    // Option: Login bei Enter-Taste
    document.getElementById('passwordInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleLogin();
        }
    });

    // Supabase Auth Listener (reagiert auf erfolgreichen Login/Logout)
    supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN') {
            console.log('User signed in. Reloading data.');
            loadData(); 
        } else if (event === 'SIGNED_OUT') {
            console.log('User signed out. Showing login view.');
            toggleViews(false);
        }
    });
});

// Mode selector change
document.getElementById('modeSelect').addEventListener('change', function() {
    if (this.value === 'simulation' && charges.length === 0) {
        if (confirm('Möchten Sie Demo-Daten generieren?')) {
            generateSimulationData();
            updateDisplay();
        }
    }
});
