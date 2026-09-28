const API_KEY = "YOUR_API_KEY";
const API_ROOT = "https://api.openweathermap.org";
const CACHE_DURATION = 5 * 60 * 1000;
const STORAGE_KEYS = {
  unit: "weathernow-unit",
  theme: "weathernow-theme",
  favorites: "weathernow-favorites",
  recents: "weathernow-recents",
};

const elements = {
  form: document.querySelector("#search-form"),
  search: document.querySelector("#city-search"),
  submit: document.querySelector("#search-submit"),
  status: document.querySelector("#app-status"),
  location: document.querySelector("#location-button"),
  unitButtons: [...document.querySelectorAll(".unit-btn")],
  theme: document.querySelector(".theme-toggle"),
  favoriteButton: document.querySelector("#add-favorite"),
  favoriteGrid: document.querySelector(".favorite-grid"),
  favoriteSection: document.querySelector(".favorites-section"),
  map: document.querySelector(".map-visual"),
};

let temperatureUnit = localStorage.getItem(STORAGE_KEYS.unit) || "metric";
let currentWeatherData = null;
let requestInProgress = false;
let requestSequence = 0;
let mapInstance = null;
let mapMarker = null;
const weatherCache = new Map();

class WeatherError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function formatTemperature(celsius, unit = temperatureUnit) {
  if (celsius === null || celsius === undefined || Number.isNaN(Number(celsius))) return "--";
  const value = unit === "imperial" ? (Number(celsius) * 9) / 5 + 32 : Number(celsius);
  return `${Math.round(value)}°${unit === "imperial" ? "F" : "C"}`;
}

function formatTime(timestamp, timezoneOffset = 0) {
  const date = new Date((timestamp + timezoneOffset) * 1000);
  return `${String(date.getUTCHours() % 12 || 12)}:${String(date.getUTCMinutes()).padStart(2, "0")} ${date.getUTCHours() >= 12 ? "PM" : "AM"}`;
}

function formatDate(timestamp, timezoneOffset = 0) {
  const date = new Date((timestamp + timezoneOffset) * 1000);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatDay(timestamp, timezoneOffset = 0) {
  const date = new Date((timestamp + timezoneOffset) * 1000);
  return new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(date);
}

function formatWindDirection(degrees) {
  if (degrees === null || degrees === undefined) return "Direction unavailable";
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return `${directions[Math.round(degrees / 45) % 8]} direction`;
}

function getWeatherIcon(condition, iconCode) {
  if (iconCode) {
    const image = document.createElement("img");
    image.src = `https://openweathermap.org/img/wn/${iconCode}@2x.png`;
    image.alt = condition || "Weather";
    image.loading = "lazy";
    return image;
  }

  const normalized = String(condition || "").toLowerCase();
  if (normalized.includes("thunder")) return document.createTextNode("⛈️");
  if (normalized.includes("drizzle")) return document.createTextNode("🌦️");
  if (normalized.includes("rain")) return document.createTextNode("🌧️");
  if (normalized.includes("snow")) return document.createTextNode("❄️");
  if (normalized.includes("cloud")) return document.createTextNode("☁️");
  if (/mist|fog|haze|smoke|dust/.test(normalized)) return document.createTextNode("🌫️");
  return document.createTextNode("☀️");
}

function setStatus(message, kind = "info") {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
  elements.status.hidden = !message;
}

function showError(message) {
  setStatus(message, "error");
}

function showLoading(message = "Loading weather…") {
  requestInProgress = true;
  elements.search.disabled = true;
  elements.submit.disabled = true;
  elements.location.disabled = true;
  elements.submit.replaceChildren();
  const spinner = document.createElement("span");
  spinner.className = "spinner-border spinner-border-sm";
  spinner.setAttribute("aria-hidden", "true");
  elements.submit.append(spinner);
  setStatus(message);
}

function hideLoading() {
  requestInProgress = false;
  elements.search.disabled = false;
  elements.submit.disabled = false;
  elements.location.disabled = false;
  const icon = document.createElement("i");
  icon.className = "bi bi-search";
  elements.submit.replaceChildren(icon);
}

async function requestJSON(path, parameters) {
  const query = new URLSearchParams({ ...parameters, appid: API_KEY });
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}?${query}`);
  } catch {
    throw new WeatherError("Network error. Check your connection and try again.");
  }

  if (!response.ok) {
    if (response.status === 401) throw new WeatherError("The OpenWeatherMap API key is invalid or not activated.", 401);
    if (response.status === 404) throw new WeatherError("We couldn't find that city. Check the spelling and try again.", 404);
    if (response.status === 429) throw new WeatherError("Weather requests are temporarily rate limited. Try again shortly.", 429);
    throw new WeatherError("Weather service is unavailable right now. Please try again.", response.status);
  }

  return response.json();
}

async function getCoordinates(city) {
  const results = await requestJSON("/geo/1.0/direct", { q: city, limit: "1" });
  if (!results.length) throw new WeatherError("We couldn't find that city. Check the spelling and try again.", 404);
  return results[0];
}

async function getCurrentWeather(latitude, longitude) {
  return requestJSON("/data/2.5/weather", {
    lat: String(latitude),
    lon: String(longitude),
    units: "metric",
  });
}

async function getForecast(latitude, longitude) {
  return requestJSON("/data/2.5/forecast", {
    lat: String(latitude),
    lon: String(longitude),
    units: "metric",
  });
}

async function getAirQuality(latitude, longitude) {
  return requestJSON("/data/2.5/air_pollution", {
    lat: String(latitude),
    lon: String(longitude),
  });
}

async function getOneCall(latitude, longitude) {
  return requestJSON("/data/3.0/onecall", {
    lat: String(latitude),
    lon: String(longitude),
    exclude: "minutely,hourly,daily",
    units: "metric",
  });
}

async function getWeatherData(location) {
  const cacheKey = `${location.lat.toFixed(3)},${location.lon.toFixed(3)}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_DURATION) return cached.data;

  const [current, forecast] = await Promise.all([
    getCurrentWeather(location.lat, location.lon),
    getForecast(location.lat, location.lon),
  ]);
  const [airQuality, oneCall] = await Promise.allSettled([
    getAirQuality(location.lat, location.lon),
    getOneCall(location.lat, location.lon),
  ]);
  const data = {
    current,
    forecast,
    airQuality: airQuality.status === "fulfilled" ? airQuality.value : null,
    oneCall: oneCall.status === "fulfilled" ? oneCall.value : null,
    location: { ...location, lat: current.coord.lat, lon: current.coord.lon },
  };
  weatherCache.set(cacheKey, { data, savedAt: Date.now() });
  return data;
}

function updateWeatherIcon(container, condition, iconCode, imageClass = "") {
  const icon = getWeatherIcon(condition, iconCode);
  if (icon instanceof HTMLImageElement && imageClass) icon.className = imageClass;
  container.replaceChildren(icon);
}

function setInfoCard(label, value, detail) {
  const card = [...document.querySelectorAll(".info-card")].find((item) =>
    item.querySelector(".label")?.textContent.trim().toLowerCase() === label.toLowerCase(),
  );
  if (!card) return;
  card.querySelector("strong").textContent = value;
  if (detail) card.querySelector("small").textContent = detail;
}

function renderCurrentWeather(data) {
  const { current, oneCall, location } = data;
  const weather = current.weather[0];
  const cityName = location.name || current.name;
  const country = location.country || current.sys.country;
  const timezoneOffset = current.timezone || 0;
  document.querySelector(".hero-head h1").textContent = `${cityName}, ${country}`;
  document.querySelector(".hero-meta").textContent = `${formatDay(Date.now() / 1000, timezoneOffset)}, ${formatDate(Date.now() / 1000, timezoneOffset)} · ${formatTime(Date.now() / 1000, timezoneOffset)}`;
  document.querySelector(".temp-value").textContent = formatTemperature(current.main.temp);
  document.querySelector(".condition-text").textContent = weather.main;
  document.querySelector(".feels-like").textContent = `${weather.description} · Feels like ${formatTemperature(current.main.feels_like)}`;
  document.querySelector(".range-row").replaceChildren(
    createTextElement("span", `H: ${formatTemperature(current.main.temp_max)}`),
    createTextElement("span", `L: ${formatTemperature(current.main.temp_min)}`),
  );
  updateWeatherIcon(document.querySelector(".hero-icon"), weather.description, weather.icon, "weather-icon-image");
  elements.favoriteButton.disabled = false;
  applyWeatherTheme(weather.main);
  renderWeatherDetails(data);
  renderSunriseSunset(current);
  renderAirQuality(data.airQuality);
  renderAlerts(oneCall?.alerts || []);
  updateMap(location, cityName);
  document.querySelector(".empty-state-card").hidden = true;
}

function createTextElement(tagName, text, className = "") {
  const element = document.createElement(tagName);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderWeatherDetails(data) {
  const { current, oneCall } = data;
  const unit = temperatureUnit === "imperial" ? "mi" : "km";
  const visibilityKm = current.visibility === undefined ? null : current.visibility / 1000;
  const visibility = visibilityKm === null
    ? "--"
    : `${temperatureUnit === "imperial" ? (visibilityKm * 0.621371).toFixed(1) : visibilityKm.toFixed(1)} ${unit}`;
  const uv = oneCall?.current?.uvi;
  const dewPoint = oneCall?.current?.dew_point;
  setInfoCard("Feels Like", formatTemperature(current.main.feels_like), current.weather[0].description);
  setInfoCard("Humidity", `${current.main.humidity}%`, "Relative humidity");
  setInfoCard("Wind", `${current.wind.speed} ${temperatureUnit === "imperial" ? "mph" : "m/s"}`, formatWindDirection(current.wind.deg));
  setInfoCard("Pressure", `${current.main.pressure} hPa`, "At sea level");
  setInfoCard("Visibility", visibility, "Current visibility");
  setInfoCard("Cloud Cover", `${current.clouds.all}%`, "Cloud coverage");
  setInfoCard("UV Index", uv === undefined ? "--" : String(uv), uv === undefined ? "Not available from this API plan" : "Current UV index");
  setInfoCard("Dew Point", dewPoint === undefined ? "--" : formatTemperature(dewPoint), dewPoint === undefined ? "Not available from this API plan" : "Current dew point");
}

function renderHourlyForecast(forecast) {
  const row = document.querySelector(".hourly-row");
  const timezoneOffset = forecast.city.timezone || 0;
  const items = forecast.list.slice(0, 9);
  row.replaceChildren(...items.map((item, index) => {
    const card = document.createElement("article");
    card.className = `hour-card${index === 0 ? " active" : ""}`;
    card.append(createTextElement("span", index === 0 ? "Next" : formatTime(item.dt, timezoneOffset), "hour-label"));
    const icon = createTextElement("span", "", "hour-icon");
    updateWeatherIcon(icon, item.weather[0].description, item.weather[0].icon);
    card.append(icon);
    card.append(createTextElement("strong", formatTemperature(item.main.temp)));
    card.append(createTextElement("small", `${Math.round((item.pop || 0) * 100)}% rain`));
    card.setAttribute("aria-label", `${formatTime(item.dt, timezoneOffset)}, ${item.weather[0].description}, ${formatTemperature(item.main.temp)}`);
    return card;
  }));
}

function renderDailyForecast(forecast) {
  const timezoneOffset = forecast.city.timezone || 0;
  const today = new Date((Date.now() + timezoneOffset * 1000)).toISOString().slice(0, 10);
  const grouped = new Map();
  forecast.list.forEach((item) => {
    const key = new Date((item.dt + timezoneOffset) * 1000).toISOString().slice(0, 10);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });

  const days = [...grouped.entries()].slice(0, 5);
  document.querySelector(".forecast-list").replaceChildren(...days.map(([dateKey, items], index) => {
    const high = Math.max(...items.map((item) => item.main.temp_max));
    const low = Math.min(...items.map((item) => item.main.temp_min));
    const rain = Math.max(...items.map((item) => item.pop || 0));
    const representative = items.reduce((best, item) =>
      item.pop > best.pop ? item : best, items[0]);
    const midnight = Math.floor(new Date(`${dateKey}T00:00:00Z`).getTime() / 1000);
    const row = document.createElement("div");
    row.className = "forecast-row";
    const day = document.createElement("div");
    day.className = "forecast-day";
    day.append(createTextElement("span", dateKey === today ? "Today" : formatDay(midnight, 0), "day-name"));
    day.append(createTextElement("span", formatDate(midnight, 0), "day-date"));
    const icon = createTextElement("div", "", "forecast-icon");
    updateWeatherIcon(icon, representative.weather[0].description, representative.weather[0].icon);
    row.append(day, icon);
    row.append(createTextElement("div", representative.weather[0].main, "forecast-cond"));
    row.append(createTextElement("div", `${formatTemperature(high)} / ${formatTemperature(low)}`, "forecast-temp"));
    row.append(createTextElement("div", `${Math.round(rain * 100)}% rain`, "forecast-rain"));
    return row;
  }));
}

function renderSunriseSunset(current) {
  const timezoneOffset = current.timezone || 0;
  document.querySelector(".sun-info-row .sun-item:first-child strong").textContent = formatTime(current.sys.sunrise, timezoneOffset);
  document.querySelector(".sun-info-row .sun-item:last-child strong").textContent = formatTime(current.sys.sunset, timezoneOffset);
  const daylightSeconds = current.sys.sunset - current.sys.sunrise;
  const hours = Math.floor(daylightSeconds / 3600);
  const minutes = Math.floor((daylightSeconds % 3600) / 60);
  document.querySelector(".day-length-box strong").textContent = `${hours}h ${minutes}m`;
}

function renderAirQuality(result) {
  const panel = document.querySelector(".air-panel");
  const top = panel.querySelector(".aqi-top");
  const metrics = panel.querySelector(".aqi-metrics");
  if (!result?.list?.[0]) {
    top.querySelector("strong").textContent = "--";
    top.querySelector(".aqi-status").textContent = "Unavailable";
    metrics.replaceChildren();
    return;
  }

  const item = result.list[0];
  const aqi = item.main.aqi;
  const labels = ["Good", "Fair", "Moderate", "Poor", "Very poor"];
  top.querySelector("strong").textContent = String(aqi);
  top.querySelector(".aqi-status").textContent = labels[aqi - 1] || "Unavailable";
  panel.querySelector(".aqi-bar").setAttribute("aria-label", `Air quality ${labels[aqi - 1] || "unavailable"}`);
  panel.querySelector(".aqi-fill").style.width = `${aqi * 20}%`;
  const pollutants = [
    ["PM2.5", item.components.pm2_5],
    ["PM10", item.components.pm10],
    ["CO", item.components.co],
    ["NO2", item.components.no2],
    ["SO2", item.components.so2],
    ["O3", item.components.o3],
  ];
  metrics.replaceChildren(...pollutants.map(([name, value]) => {
    const metric = document.createElement("div");
    metric.className = "metric-box";
    metric.append(createTextElement("span", name));
    metric.append(createTextElement("strong", value === undefined ? "--" : `${value} μg/m³`));
    return metric;
  }));
}

function renderAlerts(alerts) {
  const section = document.querySelector(".alert-card");
  if (!alerts.length) {
    section.hidden = true;
    return;
  }
  const alert = alerts[0];
  section.hidden = false;
  section.querySelector(".alert-header h3").textContent = alert.event || "Weather Alert";
  section.querySelector(".alert-header small").textContent = `${formatTime(alert.start)} - ${formatTime(alert.end)} · ${alert.tags?.[0] || "Alert"}`;
  section.querySelector("p").textContent = alert.description || "Follow local weather guidance.";
}

function applyWeatherTheme(condition) {
  const classes = ["clear", "clouds", "rain", "drizzle", "thunderstorm", "snow", "mist", "fog", "haze"];
  const normalized = String(condition || "").toLowerCase();
  const theme = classes.find((name) => normalized === name || normalized.includes(name)) || "clear";
  const hero = document.querySelector(".hero-card");
  hero.classList.remove("hero-sunny", ...classes.map((name) => `weather-${name}`));
  hero.classList.add(`weather-${theme}`);
  if (theme === "clear") hero.classList.add("hero-sunny");
  document.body.dataset.weather = theme;
}

function renderWeather(data) {
  currentWeatherData = data;
  renderCurrentWeather(data);
  renderHourlyForecast(data.forecast);
  renderDailyForecast(data.forecast);
  loadFavorites();
  setStatus(`Weather updated for ${data.location.name || data.current.name}.`, "success");
}

async function loadCoordinates(location, label) {
  if (!API_KEY || API_KEY === "YOUR_API_KEY") {
    showError("Add your OpenWeatherMap API key in js/app.js to load live weather.");
    return;
  }
  const activeRequest = ++requestSequence;
  showLoading();
  try {
    const data = await getWeatherData({ ...location, name: label || location.name, country: location.country });
    if (activeRequest !== requestSequence) return;
    renderWeather(data);
    if (label) saveRecentSearch(label);
  } catch (error) {
    if (activeRequest === requestSequence) showError(error.message || "Unable to load weather. Please try again.");
  } finally {
    if (activeRequest === requestSequence) hideLoading();
  }
}

async function searchWeather(city = elements.search.value) {
  const query = city.trim();
  if (!query) {
    showError("Enter a city name to search.");
    elements.search.focus();
    return;
  }
  if (!API_KEY || API_KEY === "YOUR_API_KEY") {
    showError("Add your OpenWeatherMap API key in js/app.js to load live weather.");
    return;
  }

  const activeRequest = ++requestSequence;
  showLoading(`Searching for ${query}…`);
  try {
    const location = await getCoordinates(query);
    const data = await getWeatherData(location);
    if (activeRequest !== requestSequence) return;
    elements.search.value = `${location.name}${location.state ? `, ${location.state}` : ""}`;
    renderWeather(data);
    saveRecentSearch(location.name);
  } catch (error) {
    if (activeRequest === requestSequence) showError(error.message || "Unable to load weather. Please try again.");
  } finally {
    if (activeRequest === requestSequence) hideLoading();
  }
}

function getCurrentLocation() {
  if (!navigator.geolocation) {
    showError("Location is not available in this browser.");
    return;
  }
  if (!API_KEY || API_KEY === "YOUR_API_KEY") {
    showError("Add your OpenWeatherMap API key in js/app.js to load live weather.");
    return;
  }
  const activeRequest = ++requestSequence;
  showLoading("Getting your location…");
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        const location = { lat: position.coords.latitude, lon: position.coords.longitude };
        const data = await getWeatherData(location);
        if (activeRequest !== requestSequence) return;
        elements.search.value = data.current.name;
        renderWeather(data);
        saveRecentSearch(data.current.name);
      } catch (error) {
        if (activeRequest === requestSequence) showError(error.message || "Unable to load weather for your location.");
      } finally {
        if (activeRequest === requestSequence) hideLoading();
      }
    },
    (error) => {
      if (activeRequest !== requestSequence) return;
      const message = error.code === error.PERMISSION_DENIED
        ? "Location permission was denied. Allow access or search for a city instead."
        : error.code === error.POSITION_UNAVAILABLE
          ? "Your location could not be determined. Try searching for a city."
          : "Location request timed out. Please try again.";
      showError(message);
      hideLoading();
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

function toggleTemperatureUnit(unit) {
  temperatureUnit = unit;
  localStorage.setItem(STORAGE_KEYS.unit, unit);
  elements.unitButtons.forEach((button) => {
    const active = (button.textContent.trim() === "°F") === (unit === "imperial");
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (currentWeatherData) renderWeather(currentWeatherData);
}

function toggleDarkMode(force) {
  const enabled = force ?? !document.body.classList.contains("dark-mode");
  document.body.classList.toggle("dark-mode", enabled);
  elements.theme.innerHTML = `<i class="bi ${enabled ? "bi-sun-fill" : "bi-moon-fill"}"></i>`;
  elements.theme.setAttribute("aria-label", enabled ? "Toggle light mode" : "Toggle dark mode");
  localStorage.setItem(STORAGE_KEYS.theme, enabled ? "dark" : "light");
}

function getStoredList(key, fallback = []) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveFavorite(city) {
  const favorites = getStoredList(STORAGE_KEYS.favorites);
  if (!favorites.some((favorite) => favorite.toLowerCase() === city.toLowerCase())) {
    favorites.push(city);
    localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(favorites));
  }
  loadFavorites();
}

function removeFavorite(city) {
  const favorites = getStoredList(STORAGE_KEYS.favorites).filter((favorite) => favorite.toLowerCase() !== city.toLowerCase());
  localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(favorites));
  loadFavorites();
}

function loadFavorites() {
  const initialCities = [...elements.favoriteGrid.querySelectorAll(".fav-top span:not(.fav-star)")].map((item) => item.textContent.trim());
  let favorites = getStoredList(STORAGE_KEYS.favorites, initialCities);
  if (!localStorage.getItem(STORAGE_KEYS.favorites) && initialCities.length) {
    localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(initialCities));
  }
  elements.favoriteGrid.replaceChildren(...favorites.map((city) => {
    const column = document.createElement("div");
    column.className = "col-6 col-md-3";
    const card = document.createElement("article");
    card.className = "favorite-card";
    card.dataset.city = city;
    const top = document.createElement("div");
    top.className = "fav-top";
    top.append(createTextElement("span", "⭐", "fav-star"));
    top.append(createTextElement("span", city));
    const remove = createTextElement("button", "×", "favorite-remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${city} from favorites`);
    top.append(remove);
    const temperature = createTextElement("div", "--", "fav-temp");
    const cached = [...weatherCache.values()].find((entry) =>
      (entry.data.location.name || entry.data.current.name).toLowerCase() === city.toLowerCase(),
    );
    if (cached) {
      temperature.textContent = formatTemperature(cached.data.current.main.temp);
      const icon = getWeatherIcon(cached.data.current.weather[0].description, cached.data.current.weather[0].icon);
      temperature.append(icon);
    }
    card.append(top, temperature);
    column.append(card);
    return column;
  }));
}

function saveRecentSearch(city) {
  const recents = getStoredList(STORAGE_KEYS.recents).filter((item) => item.toLowerCase() !== city.toLowerCase());
  recents.unshift(city);
  localStorage.setItem(STORAGE_KEYS.recents, JSON.stringify(recents.slice(0, 8)));
  loadRecentSearches();
}

function loadRecentSearches() {
  let container = document.querySelector(".recent-searches");
  if (!container) {
    container = document.createElement("div");
    container.className = "recent-searches";
    container.setAttribute("aria-label", "Recent searches");
    elements.favoriteSection.after(container);
  }
  const recents = getStoredList(STORAGE_KEYS.recents);
  container.hidden = recents.length === 0;
  container.replaceChildren(...recents.map((city) => {
    const button = createTextElement("button", city);
    button.type = "button";
    button.addEventListener("click", () => searchWeather(city));
    return button;
  }));
}

function toggleFavoriteForCurrentCity() {
  const city = currentWeatherData?.location.name || currentWeatherData?.current.name;
  if (city) saveFavorite(city);
}

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (window.leafletPromise) return window.leafletPromise;
  window.leafletPromise = new Promise((resolve, reject) => {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.append(stylesheet);
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error("Map tiles are unavailable."));
    document.head.append(script);
  });
  return window.leafletPromise;
}

async function updateMap(location, cityName) {
  try {
    const leaflet = await loadLeaflet();
    if (!document.querySelector("#weather-map")) {
      const mapElement = document.createElement("div");
      mapElement.id = "weather-map";
      mapElement.setAttribute("role", "application");
      mapElement.setAttribute("aria-label", `Map showing ${cityName}`);
      elements.map.prepend(mapElement);
    }
    elements.map.classList.add("map-ready");
    if (!mapInstance) {
      mapInstance = leaflet.map("weather-map").setView([location.lat, location.lon], 10);
      leaflet.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(mapInstance);
      mapMarker = leaflet.marker([location.lat, location.lon]).addTo(mapInstance);
    } else {
      mapInstance.setView([location.lat, location.lon], 10);
      mapMarker.setLatLng([location.lat, location.lon]);
    }
    mapMarker.bindPopup(`${cityName}<br>${location.lat.toFixed(3)}, ${location.lon.toFixed(3)}`);
    mapInstance.invalidateSize();
  } catch {
    const badge = elements.map.querySelector(".map-badge");
    if (badge) badge.textContent = `${cityName} · ${location.lat.toFixed(3)}, ${location.lon.toFixed(3)}`;
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  searchWeather();
});
elements.location.addEventListener("click", getCurrentLocation);
elements.theme.addEventListener("click", () => toggleDarkMode());
elements.favoriteButton.addEventListener("click", toggleFavoriteForCurrentCity);
elements.unitButtons.forEach((button) => {
  button.addEventListener("click", () => toggleTemperatureUnit(button.textContent.trim() === "°F" ? "imperial" : "metric"));
});
elements.favoriteGrid.addEventListener("click", (event) => {
  const removeButton = event.target.closest(".favorite-remove");
  const card = event.target.closest(".favorite-card");
  if (!card) return;
  if (removeButton) removeFavorite(card.dataset.city);
  else searchWeather(card.dataset.city);
});
document.querySelector(".empty-search-btn").addEventListener("click", () => elements.search.focus());

toggleTemperatureUnit(temperatureUnit === "imperial" ? "imperial" : "metric");
toggleDarkMode(localStorage.getItem(STORAGE_KEYS.theme) === "dark");
document.querySelector(".alert-card").hidden = true;
elements.favoriteButton.disabled = true;
loadFavorites();
loadRecentSearches();
if (API_KEY === "YOUR_API_KEY") {
  showError("Add your OpenWeatherMap API key in js/app.js to load live weather.");
} else {
  searchWeather();
}