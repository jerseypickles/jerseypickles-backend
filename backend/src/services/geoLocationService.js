// backend/src/services/geoLocationService.js
// 🌍 Servicio de Geolocalización por IP para SMS Analytics

const axios = require('axios');

class GeoLocationService {
  constructor() {
    // Cache para evitar llamadas repetidas (IP -> location)
    this.cache = new Map();
    this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 horas

    // Rate limiting: ip-api.com permite 45 req/min en free tier
    this.requestQueue = [];
    this.isProcessingQueue = false;
    this.requestDelay = 1500; // 1.5 segundos entre requests
  }

  /**
   * Obtener ubicación por IP usando ip-api.com (gratuito, no requiere API key)
   * @param {string} ip - Dirección IP
   * @returns {Promise<Object>} Datos de ubicación
   */
  async getLocationByIp(ip) {
    // Validar IP
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return this.getDefaultLocation();
    }

    // Limpiar IP (remover puerto si existe)
    const cleanIp = ip.split(':')[0].replace('::ffff:', '');

    // Verificar cache
    const cached = this.cache.get(cleanIp);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.data;
    }

    try {
      // ip-api.com - Free tier (45 req/min, sin API key)
      const response = await axios.get(`http://ip-api.com/json/${cleanIp}`, {
        timeout: 5000,
        params: {
          fields: 'status,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp'
        }
      });

      if (response.data.status === 'success') {
        const location = {
          country: response.data.country || 'United States',
          countryCode: response.data.countryCode || 'US',
          region: response.data.region || null,
          regionName: response.data.regionName || null,
          city: response.data.city || null,
          zip: response.data.zip || null,
          lat: response.data.lat || null,
          lng: response.data.lon || null,
          timezone: response.data.timezone || 'America/New_York',
          isp: response.data.isp || null,
          source: 'ip-api',
          resolvedAt: new Date()
        };

        // Guardar en cache
        this.cache.set(cleanIp, {
          data: location,
          timestamp: Date.now()
        });

        return location;
      }

      console.log(`⚠️ ip-api returned non-success for ${cleanIp}:`, response.data.message);
      return this.getDefaultLocation();

    } catch (error) {
      console.error(`❌ Error geolocating IP ${cleanIp}:`, error.message);
      return this.getDefaultLocation();
    }
  }

  /**
   * Geolocalizar múltiples IPs en batch (con rate limiting)
   * @param {string[]} ips - Array de IPs
   * @returns {Promise<Map>} Map de IP -> location
   */
  async batchGeolocate(ips) {
    const results = new Map();
    const uniqueIps = [...new Set(ips)].filter(ip => ip);

    console.log(`🌍 Geolocating ${uniqueIps.length} unique IPs...`);

    for (const ip of uniqueIps) {
      // Verificar cache primero
      const cleanIp = ip.split(':')[0].replace('::ffff:', '');
      const cached = this.cache.get(cleanIp);

      if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
        results.set(ip, cached.data);
        continue;
      }

      // Agregar delay para rate limiting
      await this.delay(this.requestDelay);

      const location = await this.getLocationByIp(ip);
      results.set(ip, location);
    }

    console.log(`✅ Geolocated ${results.size} IPs`);
    return results;
  }

  /**
   * Ubicación por defecto cuando no se puede resolver la IP
   */
  getDefaultLocation() {
    return {
      country: 'United States',
      countryCode: 'US',
      region: null,
      regionName: null,
      city: null,
      zip: null,
      lat: null,
      lng: null,
      timezone: 'America/New_York',
      isp: null,
      source: 'default',
      resolvedAt: new Date()
    };
  }

  /**
   * Obtener estado de USA por coordenadas o nombre de región
   * @param {Object} location - Objeto de ubicación
   * @returns {string|null} Código de estado (ej: 'NJ', 'NY')
   */
  getUsState(location) {
    if (!location || location.countryCode !== 'US') {
      return null;
    }

    // Si tenemos el código de región directamente
    if (location.region && location.region.length === 2) {
      return location.region.toUpperCase();
    }

    // Mapeo de nombres completos a códigos
    const stateMap = {
      'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
      'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
      'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
      'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
      'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
      'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
      'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
      'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
      'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
      'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
      'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
      'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
      'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC'
    };

    if (location.regionName) {
      const stateName = location.regionName.toLowerCase();
      return stateMap[stateName] || null;
    }

    return null;
  }

  /**
   * Agregar coordenadas para estados de USA (centroide)
   * Útil para el mapa cuando solo tenemos el estado
   */
  getStateCentroid(stateCode) {
    const centroids = {
      'AL': { lat: 32.806671, lng: -86.791130 },
      'AK': { lat: 61.370716, lng: -152.404419 },
      'AZ': { lat: 33.729759, lng: -111.431221 },
      'AR': { lat: 34.969704, lng: -92.373123 },
      'CA': { lat: 36.116203, lng: -119.681564 },
      'CO': { lat: 39.059811, lng: -105.311104 },
      'CT': { lat: 41.597782, lng: -72.755371 },
      'DE': { lat: 39.318523, lng: -75.507141 },
      'FL': { lat: 27.766279, lng: -81.686783 },
      'GA': { lat: 33.040619, lng: -83.643074 },
      'HI': { lat: 21.094318, lng: -157.498337 },
      'ID': { lat: 44.240459, lng: -114.478828 },
      'IL': { lat: 40.349457, lng: -88.986137 },
      'IN': { lat: 39.849426, lng: -86.258278 },
      'IA': { lat: 42.011539, lng: -93.210526 },
      'KS': { lat: 38.526600, lng: -96.726486 },
      'KY': { lat: 37.668140, lng: -84.670067 },
      'LA': { lat: 31.169546, lng: -91.867805 },
      'ME': { lat: 44.693947, lng: -69.381927 },
      'MD': { lat: 39.063946, lng: -76.802101 },
      'MA': { lat: 42.230171, lng: -71.530106 },
      'MI': { lat: 43.326618, lng: -84.536095 },
      'MN': { lat: 45.694454, lng: -93.900192 },
      'MS': { lat: 32.741646, lng: -89.678696 },
      'MO': { lat: 38.456085, lng: -92.288368 },
      'MT': { lat: 46.921925, lng: -110.454353 },
      'NE': { lat: 41.125370, lng: -98.268082 },
      'NV': { lat: 38.313515, lng: -117.055374 },
      'NH': { lat: 43.452492, lng: -71.563896 },
      'NJ': { lat: 40.298904, lng: -74.521011 },
      'NM': { lat: 34.840515, lng: -106.248482 },
      'NY': { lat: 42.165726, lng: -74.948051 },
      'NC': { lat: 35.630066, lng: -79.806419 },
      'ND': { lat: 47.528912, lng: -99.784012 },
      'OH': { lat: 40.388783, lng: -82.764915 },
      'OK': { lat: 35.565342, lng: -96.928917 },
      'OR': { lat: 44.572021, lng: -122.070938 },
      'PA': { lat: 40.590752, lng: -77.209755 },
      'RI': { lat: 41.680893, lng: -71.511780 },
      'SC': { lat: 33.856892, lng: -80.945007 },
      'SD': { lat: 44.299782, lng: -99.438828 },
      'TN': { lat: 35.747845, lng: -86.692345 },
      'TX': { lat: 31.054487, lng: -97.563461 },
      'UT': { lat: 40.150032, lng: -111.862434 },
      'VT': { lat: 44.045876, lng: -72.710686 },
      'VA': { lat: 37.769337, lng: -78.169968 },
      'WA': { lat: 47.400902, lng: -121.490494 },
      'WV': { lat: 38.491226, lng: -80.954453 },
      'WI': { lat: 44.268543, lng: -89.616508 },
      'WY': { lat: 42.755966, lng: -107.302490 },
      'DC': { lat: 38.897438, lng: -77.026817 }
    };

    return centroids[stateCode] || null;
  }

  /**
   * Helper para delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Limpiar cache expirado
   */
  cleanExpiredCache() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.cacheExpiry) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 Cleaned ${cleaned} expired entries from geo cache`);
    }

    return cleaned;
  }

  /**
   * Obtener estadísticas del cache
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      expiryHours: this.cacheExpiry / (60 * 60 * 1000)
    };
  }
}

const geoLocationService = new GeoLocationService();
module.exports = geoLocationService;
