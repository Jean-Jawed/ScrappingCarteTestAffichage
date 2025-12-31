/**
 * Marseille Events Data Controller
 */

class EventManager {
    constructor() {
        this.events = [];
        this.locations = [];
        this.mergedData = [];

        // Filter State
        this.filterState = {
            period: 'all', // 'today', 'tomorrow', 'week', 'month', 'next_month', 'custom', 'all'
            customStart: null,
            customEnd: null,
            includePast: false,
            exclusiveMode: false,
            searchQuery: null // Renamed from 'tag' to be generic
        };
        this.allTags = new Set();
        this.uniquePlaces = new Set();
    }

    async init() {
        try {
            // 1. Fetch the manifest
            const manifestRes = await fetch('files.json');
            const manifest = await manifestRes.json();

            // 2. Load all event files in parallel
            // 2. Load all event files in parallel
            // We verify that the file exists and is valid, otherwise we ignore it
            const safeFetch = (file) =>
                fetch(file)
                    .then(res => {
                        if (!res.ok) throw new Error(`Status ${res.status}`);
                        return res.json();
                    })
                    .catch(e => {
                        console.warn(`File ignored (not found or invalid): ${file}`, e);
                        return [];
                    });

            const eventPromises = manifest.events.map(file => safeFetch(file));

            // 3. Load all location files in parallel
            const locationPromises = manifest.locations.map(file => safeFetch(file));

            // Wait for all fetches
            const [eventsArrays, locationsArrays] = await Promise.all([
                Promise.all(eventPromises),
                Promise.all(locationPromises)
            ]);

            // 4. Flatten the arrays
            const allEvents = eventsArrays.flat();
            this.locations = locationsArrays.flat();

            // 5. Deduplicate Events
            // Strategy: Same lieu + start_date + end_date = duplicate.
            const uniqueEvents = [];
            const seen = new Set();

            allEvents.forEach(evt => {
                // Normalize key: Use lowercase for lieu to be safer, though user said "same lieu"
                // strict equality might be enough if sources are consistent, but let's be robust.
                const key = `${evt.lieu}|${evt.start_date}|${evt.end_date}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    uniqueEvents.push(evt);
                }
            });

            this.events = uniqueEvents;
            console.log(`Deduplication: Reduced ${allEvents.length} to ${this.events.length} events.`);

            this.mergeData();
            console.log('Data loaded:', this.mergedData.length, 'events from', manifest.events.length, 'files');
            return this.mergedData;
        } catch (error) {
            console.error('Error loading data:', error);
            return [];
        }
    }

    mergeData() {
        // Create a map of locations for faster lookup
        const locMap = new Map();
        this.locations.forEach(loc => {
            if (loc.status === "OK") {
                locMap.set(loc.nom_original, loc);
            }
        });

        this.mergedData = this.events.map(event => {
            const placeInfo = locMap.get(event.lieu);
            // Even if no geo info, we keep the event for the list view, 
            // but for map we will filter later.
            return {
                ...event,
                _geo: placeInfo || null
            };
        });

        this.extractUniqueTags();
    }

    extractUniqueTags() {
        this.allTags.clear();
        this.uniquePlaces.clear();

        this.mergedData.forEach(evt => {
            // Tags
            if (Array.isArray(evt.tags)) {
                evt.tags.forEach(tag => this.allTags.add(tag));
            } else if (typeof evt.tags === 'string') {
                evt.tags.split(',').forEach(t => this.allTags.add(t.trim()));
            }

            // Places
            if (evt.lieu) {
                this.uniquePlaces.add(evt.lieu);
            }
        });
        console.log(`Extracted ${this.allTags.size} tags and ${this.uniquePlaces.size} places.`);
    }

    getSuggestionsMatching(query) {
        if (!query) return [];
        const lowerQ = query.toLowerCase();

        const tags = Array.from(this.allTags)
            .filter(tag => tag.toLowerCase().includes(lowerQ))
            .sort()
            .map(t => ({ type: 'Tag', value: t })); // Add type for UI if needed

        const places = Array.from(this.uniquePlaces)
            .filter(place => place.toLowerCase().includes(lowerQ))
            .sort()
            .map(p => ({ type: 'Lieu', value: p }));

        // Return mixed results
        return [...places, ...tags];
    }

    // --- Date Helpers ---

    getTodayStr() {
        return new Date().toISOString().split('T')[0];
    }

    getMonthRange(offset = 0) {
        const now = new Date();
        // Set to 1st of the target month
        const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        // Set to last day of target month (day 0 of next month)
        const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);

        // Adjust formatting
        const fmt = (d) => {
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        return { start: fmt(start), end: fmt(end) };
    }

    getNextDay(dateStr, days = 1) {
        const d = new Date(dateStr);
        d.setDate(d.getDate() + days);
        return d.toISOString().split('T')[0];
    }

    getMonthNames() {
        const options = { month: 'long' };
        const now = new Date();
        const current = new Intl.DateTimeFormat('fr-FR', options).format(now);

        const nextDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const next = new Intl.DateTimeFormat('fr-FR', options).format(nextDate);

        // Capitalize
        const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
        return { current: cap(current), next: cap(next) };
    }

    // --- State setters ---

    setFilterPeriod(period) {
        this.filterState.period = period;
    }

    setCustomDates(start, end) {
        this.filterState.period = 'custom';
        this.filterState.customStart = start;
        this.filterState.customEnd = end;
    }

    setIncludePast(bool) {
        this.filterState.includePast = bool;
    }

    setExclusiveMode(bool) {
        this.filterState.exclusiveMode = bool;
    }

    setTagFilter(query) {
        this.filterState.searchQuery = query;
    }

    // --- Core Logic ---

    getFilteredEvents() {
        // 1. Determine Filtering Range
        const now = new Date();
        const todayStr = this.getTodayStr();

        let filterStart = null;
        let filterEnd = null;

        switch (this.filterState.period) {
            case 'today':
                filterStart = todayStr;
                filterEnd = todayStr;
                break;
            case 'tomorrow':
                const tmrw = this.getNextDay(todayStr, 1);
                filterStart = tmrw;
                filterEnd = tmrw;
                break;
            case 'week':
                filterStart = todayStr;
                filterEnd = this.getNextDay(todayStr, 7);
                break;
            case 'month':
                // Calendar month
                const m = this.getMonthRange(0);
                filterStart = m.start;
                filterEnd = m.end;
                break;
            case 'next_month':
                const nm = this.getMonthRange(1);
                filterStart = nm.start;
                filterEnd = nm.end;
                break;
            case 'custom':
                filterStart = this.filterState.customStart;
                filterEnd = this.filterState.customEnd;
                break;
            case 'all':
            default:
                // No range filter
                break;
        }

        return this.mergedData.filter(evt => {
            if (!evt.start_date || !evt.end_date) return false;

            // A. Past Events Check
            // Logic: if !includePast, event MUST NOT have ended before today.
            // i.e. evt.end_date must be >= todayStr
            if (!this.filterState.includePast) {
                if (evt.end_date < todayStr) return false;
            }

            // If periods is 'all' and no custom range, we still need to check Tag/Search later
            // logic below handles dates, if 'all' we skip date check but keep exclusive/past checks if needed?
            // Actually: "All" usually means ANY date.
            // But we must NOT return true immediately if we want to check SearchQuery.
            let skipDateCheck = false;
            if (this.filterState.period === 'all') skipDateCheck = true;

            // If custom range is incomplete, treat as 'all' (or block?) -> treat as all for now
            if ((this.filterState.period === 'custom') && (!filterStart || !filterEnd)) return true;

            // B. Range Check
            let dateMatch = false;
            if (skipDateCheck) {
                dateMatch = true;
            } else if (this.filterState.exclusiveMode) {
                // EXCLUSIVE: Event must start AFTER filterStart AND end BEFORE filterEnd
                dateMatch = evt.start_date >= filterStart && evt.end_date <= filterEnd;
            } else {
                // INCLUSIVE (Overlap): Event ends AFTER filterStart AND starts BEFORE filterEnd
                dateMatch = evt.end_date >= filterStart && evt.start_date <= filterEnd;
            }
            if (!dateMatch) return false;

            if (!dateMatch) return false;

            // C. Global Search Check (Name, Place, Tag, Description)
            if (this.filterState.searchQuery) {
                const q = this.filterState.searchQuery.toLowerCase();
                let match = false;

                // 1. Title
                if (evt.titre && evt.titre.toLowerCase().includes(q)) match = true;

                // 2. Place
                if (!match && evt.lieu && evt.lieu.toLowerCase().includes(q)) match = true;

                // 3. Tags
                if (!match && evt.tags) {
                    if (Array.isArray(evt.tags)) {
                        if (evt.tags.some(t => t.toLowerCase().includes(q))) match = true;
                    } else if (typeof evt.tags === 'string') {
                        if (evt.tags.toLowerCase().includes(q)) match = true;
                    }
                }

                // 4. Description (Optional, can be slow/noisy)
                // if (!match && evt.description && evt.description.toLowerCase().includes(q)) match = true;

                if (!match) return false;
            }

            return true;
        });
    }

    searchEvents(query) {
        // First get filtered events based on current settings? 
        // Or search on all data? User usually expects search to work on global data, 
        // but maybe within the filter?
        // Let's search on global data for now as per previous implementation, 
        // OR search on filtered data? 
        // Previous impl: searched on mergedData. Let's keep it simple.
        if (!query) return this.mergedData;
        const lowerQ = query.toLowerCase();
        return this.mergedData.filter(evt =>
            evt.titre.toLowerCase().includes(lowerQ) ||
            (evt.description && evt.description.toLowerCase().includes(lowerQ)) ||
            (evt.lieu && evt.lieu.toLowerCase().includes(lowerQ))
        );
    }
}

// Global instance
const eventManager = new EventManager();
