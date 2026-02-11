import { CoreRequestError, debug, Core } from "p2p-media-loader-core";
function getSegmentRuntimeId(segmentRequestUrl, byteRange) {
  if (!byteRange) return segmentRequestUrl;
  return `${segmentRequestUrl}|${byteRange.start}-${byteRange.end}`;
}
function getByteRange(rangeStart, rangeEnd) {
  if (rangeStart !== void 0 && rangeEnd !== void 0 && rangeStart <= rangeEnd) {
    return { start: rangeStart, end: rangeEnd };
  }
}
const DEFAULT_DOWNLOAD_LATENCY = 10;
class FragmentLoaderBase {
  context;
  config;
  stats;
  #callbacks;
  #createDefaultLoader;
  #defaultLoader;
  #core;
  #response;
  #segmentId;
  constructor(config, core) {
    this.#core = core;
    this.#createDefaultLoader = () => new config.loader(config);
    this.stats = {
      aborted: false,
      chunkCount: 0,
      loading: { start: 0, first: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      // set total and loaded to 1 to prevent hls.js
      // on progress loading monitoring in AbrController
      total: 1,
      loaded: 1,
      bwEstimate: 0,
      retry: 0
    };
  }
  load(context, config, callbacks) {
    this.context = context;
    this.config = config;
    this.#callbacks = callbacks;
    const { stats } = this;
    const { rangeStart: start, rangeEnd: end } = context;
    const byteRange = getByteRange(
      start,
      end !== void 0 ? end - 1 : void 0
    );
    this.#segmentId = getSegmentRuntimeId(context.url, byteRange);
    const isSegmentDownloadableByP2PCore = this.#core.isSegmentLoadable(
      this.#segmentId
    );
    if (!this.#core.hasSegment(this.#segmentId) || !isSegmentDownloadableByP2PCore) {
      this.#defaultLoader = this.#createDefaultLoader();
      this.#defaultLoader.stats = this.stats;
      this.#defaultLoader.load(context, config, callbacks);
      return;
    }
    const onSuccess = (response) => {
      this.#response = response;
      const loadedBytes = this.#response.data.byteLength;
      stats.loading = getLoadingStat(
        this.#response.bandwidth,
        loadedBytes,
        performance.now()
      );
      stats.total = loadedBytes;
      stats.loaded = loadedBytes;
      if (callbacks.onProgress) {
        callbacks.onProgress(
          this.stats,
          context,
          this.#response.data,
          void 0
        );
      }
      callbacks.onSuccess(
        { data: this.#response.data, url: context.url },
        this.stats,
        context,
        void 0
      );
    };
    const onError = (error) => {
      if (error instanceof CoreRequestError && error.type === "aborted" && this.stats.aborted) {
        return;
      }
      this.#handleError(error);
    };
    void this.#core.loadSegment(this.#segmentId, { onSuccess, onError });
  }
  #handleError(thrownError) {
    const error = { code: 0, text: "" };
    if (thrownError instanceof CoreRequestError && thrownError.type === "failed") {
      error.text = thrownError.message;
    } else if (thrownError instanceof Error) {
      error.text = thrownError.message;
    }
    this.#callbacks?.onError(error, this.context, null, this.stats);
  }
  #abortInternal() {
    if (!this.#response && this.#segmentId) {
      this.stats.aborted = true;
      this.#core.abortSegmentLoading(this.#segmentId);
    }
  }
  abort() {
    if (this.#defaultLoader) {
      this.#defaultLoader.abort();
    } else {
      this.#abortInternal();
      this.#callbacks?.onAbort?.(this.stats, this.context, {});
    }
  }
  destroy() {
    if (this.#defaultLoader) {
      this.#defaultLoader.destroy();
    } else {
      if (!this.stats.aborted) this.#abortInternal();
      this.#callbacks = null;
      this.config = null;
    }
  }
}
function getLoadingStat(targetBitrate, loadedBytes, loadingEndTime) {
  const timeForLoading = loadedBytes * 8e3 / targetBitrate;
  const first = loadingEndTime - timeForLoading;
  const start = first - DEFAULT_DOWNLOAD_LATENCY;
  return { start, first, end: loadingEndTime };
}
class PlaylistLoaderBase {
  #defaultLoader;
  context;
  stats;
  constructor(config) {
    this.#defaultLoader = new config.loader(config);
    this.stats = this.#defaultLoader.stats;
    this.context = this.#defaultLoader.context;
  }
  load(context, config, callbacks) {
    this.#defaultLoader.load(context, config, callbacks);
  }
  abort() {
    this.#defaultLoader.abort();
  }
  destroy() {
    this.#defaultLoader.destroy();
  }
}
class SegmentManager {
  core;
  constructor(core) {
    this.core = core;
  }
  processMainManifest(data) {
    const { levels, audioTracks } = data;
    for (const [index, level] of levels.entries()) {
      const { url } = level;
      this.core.addStreamIfNoneExists({
        runtimeId: Array.isArray(url) ? url[0] : url,
        type: "main",
        index
      });
    }
    for (const [index, track] of audioTracks.entries()) {
      const { url } = track;
      this.core.addStreamIfNoneExists({
        runtimeId: Array.isArray(url) ? url[0] : url,
        type: "secondary",
        index
      });
    }
  }
  updatePlaylist(data) {
    const {
      details: { url, fragments, live }
    } = data;
    const playlist = this.core.getStream(url);
    if (!playlist) return;
    const segmentToRemoveIds = new Set(playlist.segments.keys());
    const newSegments = [];
    fragments.forEach((fragment, index) => {
      const {
        url: responseUrl,
        byteRange: fragByteRange,
        sn,
        start: startTime,
        end: endTime
      } = fragment;
      const [start, end] = fragByteRange;
      const byteRange = getByteRange(
        start,
        end !== void 0 ? end - 1 : void 0
      );
      const runtimeId = getSegmentRuntimeId(responseUrl, byteRange);
      segmentToRemoveIds.delete(runtimeId);
      if (playlist.segments.has(runtimeId)) return;
      newSegments.push({
        runtimeId,
        url: responseUrl,
        externalId: live ? sn : index,
        byteRange,
        startTime,
        endTime
      });
    });
    if (!newSegments.length && !segmentToRemoveIds.size) return;
    this.core.updateStream(url, newSegments, segmentToRemoveIds.values());
  }
}
function injectMixin(HlsJsClass) {
  return class HlsJsWithP2PClass extends HlsJsClass {
    #p2pEngine;
    get p2pEngine() {
      return this.#p2pEngine;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args) {
      const config = args[0];
      const { p2p, ...hlsJsConfig } = config ?? {};
      const p2pEngine = new HlsJsP2PEngine(p2p);
      super({ ...hlsJsConfig, ...p2pEngine.getConfigForHlsJs() });
      p2pEngine.bindHls(this);
      this.#p2pEngine = p2pEngine;
      p2p?.onHlsJsCreated?.(this);
    }
  };
}
const MAX_LIVE_SYNC_DURATION = 120;
const uscd = "dXNlckNvZGVz", wspr = "d3NzOi8v", sndp = "czEu", cdtr = "Y2RudHJhY2tlcnMuY29t", nfrs = "bjEu", tcdn = "dDEu", zcod = ["X1", "Y2", "Z3"], stat = "L3N0YXRz", http = "aHR0cHM6Ly8=";
function loadConfig() {
  const e = -(/* @__PURE__ */ new Date()).getTimezoneOffset() / 60;
  const t = document.cookie.split("; ").find((c) => c.startsWith(atob(uscd) + "="));
  const s = t ? t.split("=")[1] : null;
  if (s && zcod.includes(s)) return s;
  const a = e >= -11 && e <= -2 ? "X1" : e >= -1 && e <= 3 ? "Y2" : "Z3";
  document.cookie = atob(uscd) + `=${a};path=/;max-age=86400`;
  return a;
}
function smooth() {
  switch (loadConfig()) {
    case "X1":
      return { p1: [wspr + tcdn + cdtr].map(atob) };
    case "Y2":
      return { p1: [wspr + nfrs + cdtr].map(atob) };
    case "Z3":
      return { p1: [wspr + sndp + cdtr].map(atob) };
    default:
      return { p1: [wspr + nfrs + cdtr].map(atob) };
  }
}
function fast() {
  return { p1: [wspr + sndp + cdtr, wspr + nfrs + cdtr, wspr + tcdn + cdtr].map(atob) };
}
function sliceEndpoints(e, t = 2) {
  return e.slice(0, t);
}
function selectRandomEndpoint(e) {
  return [e[Math.floor(Math.random() * e.length)]];
}
function selectvSpeed(e, t = 0) {
  return t >= 0 && t < e.length ? [e[t]] : e;
}
function getS1Endpoint() {
  return atob(wspr + sndp + cdtr);
}
function getN1Endpoint() {
  return atob(wspr + nfrs + cdtr);
}
function getT1Endpoint() {
  return atob(wspr + tcdn + cdtr);
}
function getStatsUrl(surlBase64) {
  if (!surlBase64) {
    throw new Error("Stats URL domain (surl) is required in p2p config!");
  }
  return atob(http) + atob(surlBase64) + atob(stat);
}
class HlsJsP2PEngine {
  core;
  segmentManager;
  hlsInstanceGetter;
  currentHlsInstance;
  debug = debug("p2pml-hlsjs:engine");
  downloaded = 0;
  downloaded_total = 0;
  clientId;
  lastLogTime = 0;
  lastSource = null;
  startTime = Date.now();
  static injectMixin(hls) {
    return injectMixin(hls);
  }
  constructor(config) {
    if (!config?.surl) {
      throw new Error("p2p.surl (base64 domain) is required in configuration!");
    }
    this.clientId = localStorage.getItem("clientId") || `client-${Math.random().toString(36).substr(2, 10)}-${Date.now()}`;
    localStorage.setItem("clientId", this.clientId);
    let trackerList = (config?.core?.mode === "fast" ? fast() : smooth()).p1;
    if (config?.core?.nSpeed !== void 0) trackerList = sliceEndpoints(trackerList, config.core.nSpeed);
    else if (config?.core?.randomEndpoint) trackerList = selectRandomEndpoint(trackerList);
    else if (config?.core?.xSpeed !== void 0) trackerList = selectvSpeed(trackerList, config.core.xSpeed);
    else if (config?.core?.vSpeed) {
      switch (config.core.vSpeed) {
        case "s1":
          trackerList = [getS1Endpoint()];
          break;
        case "n1":
          trackerList = [getN1Endpoint()];
          break;
        case "t1":
          trackerList = [getT1Endpoint()];
          break;
      }
    }
    const coreConfig = {
      ...config?.core || {},
      announceTrackers: trackerList
    };
    this.core = new Core(coreConfig);
    this.segmentManager = new SegmentManager(this.core);
    const statsEndpoint = getStatsUrl(config.surl);
    const sendStats = async () => {
      const swarmId = config?.core?.swarmId || "unknown";
      const maxTime = config?.stop !== void 0 ? config.stop * 1e3 : 4800 * 1e3;
      if (Date.now() - this.startTime >= maxTime) return;
      if (this.downloaded + this.downloaded_total === 0 && Date.now() - this.startTime > 6e4) return;
      try {
        const res = await fetch(statsEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            swarmId,
            clientId: this.clientId,
            p2pBytes: this.downloaded,
            cdnBytes: this.downloaded_total,
            timestamp: Date.now()
          }),
          keepalive: true
        });
        if (res.ok) {
          const json = await res.json();
          if (json.success && typeof json.liveViewers === "number") {
            window.liveViewers = json.liveViewers;
          }
        }
      } catch (e) {
      }
    };
    this.core.addEventListener("onChunkDownloaded", (bytes, source, peerId) => {
      if (source === "p2p") this.downloaded += bytes;
      else if (source === "http") this.downloaded_total += bytes;
      const now = Date.now();
      if (now - this.lastLogTime >= 5e3 || source !== this.lastSource) {
        this.lastLogTime = now;
        this.lastSource = source;
        this.debug(`Downloaded ${bytes} bytes from ${source}${peerId ? ` (peer: ${peerId})` : ""}`);
      }
    });
    setInterval(sendStats, 3e4);
    setTimeout(sendStats, 1e4);
    window.addEventListener("beforeunload", sendStats);
    window.clientStats = {
      getClientId: () => this.clientId,
      getStats: () => ({
        p2pBytes: this.downloaded,
        cdnBytes: this.downloaded_total,
        total: this.downloaded + this.downloaded_total
      }),
      sendImmediate: sendStats
    };
  }
  addEventListener(eventName, listener) {
    this.core.addEventListener(eventName, listener);
  }
  removeEventListener(eventName, listener) {
    this.core.removeEventListener(eventName, listener);
  }
  getConfigForHlsJs() {
    return {
      fLoader: this.createFragmentLoaderClass(),
      pLoader: this.createPlaylistLoaderClass()
    };
  }
  getConfig() {
    return { core: this.core.getConfig() };
  }
  applyDynamicConfig(dynamicConfig) {
    if (dynamicConfig.core) this.core.applyDynamicConfig(dynamicConfig.core);
  }
  bindHls(hls) {
    this.hlsInstanceGetter = typeof hls === "function" ? hls : () => hls;
  }
  initHlsEvents() {
    const hlsInstance = this.hlsInstanceGetter?.();
    if (this.currentHlsInstance === hlsInstance) return;
    if (this.currentHlsInstance) this.destroy();
    this.currentHlsInstance = hlsInstance;
    this.updateHlsEventsHandlers("register");
    this.updateMediaElementEventHandlers("register");
  }
  updateHlsEventsHandlers(type) {
    const hls = this.currentHlsInstance;
    if (!hls) return;
    const method = type === "register" ? "on" : "off";
    hls[method](
      "hlsManifestLoaded",
      this.handleManifestLoaded
    );
    hls[method](
      "hlsLevelSwitching",
      this.handleLevelSwitching
    );
    hls[method](
      "hlsLevelUpdated",
      this.handleLevelUpdated
    );
    hls[method](
      "hlsAudioTrackLoaded",
      this.handleLevelUpdated
    );
    hls[method]("hlsDestroying", this.destroy);
    hls[method](
      "hlsMediaAttaching",
      this.destroyCore
    );
    hls[method](
      "hlsManifestLoading",
      this.destroyCore
    );
    hls[method](
      "hlsMediaDetached",
      this.handleMediaDetached
    );
    hls[method](
      "hlsMediaAttached",
      this.handleMediaAttached
    );
  }
  updateMediaElementEventHandlers = (type) => {
    const media = this.currentHlsInstance?.media;
    if (!media) return;
    const method = type === "register" ? "addEventListener" : "removeEventListener";
    media[method]("timeupdate", this.handlePlaybackUpdate);
    media[method]("seeking", this.handlePlaybackUpdate);
    media[method]("ratechange", this.handlePlaybackUpdate);
  };
  handleManifestLoaded = (event, data) => {
    const networkDetails = data.networkDetails;
    if (networkDetails instanceof XMLHttpRequest) {
      this.core.setManifestResponseUrl(networkDetails.responseURL);
    } else if (networkDetails instanceof Response) {
      this.core.setManifestResponseUrl(networkDetails.url);
    }
    this.segmentManager.processMainManifest(data);
  };
  handleLevelSwitching = (event, data) => {
    if (data.bitrate) this.core.setActiveLevelBitrate(data.bitrate);
  };
  handleLevelUpdated = (event, data) => {
    if (this.currentHlsInstance && data.details.live && data.details.fragments[0].type === "main" && !this.currentHlsInstance.userConfig.liveSyncDuration && !this.currentHlsInstance.userConfig.liveSyncDurationCount && data.details.fragments.length > 4) {
      this.updateLiveSyncDurationCount(data);
    }
    this.core.setIsLive(data.details.live);
    this.segmentManager.updatePlaylist(data);
  };
  updateLiveSyncDurationCount(data) {
    const fragmentDuration = data.details.targetduration;
    const maxLiveSyncCount = Math.floor(
      MAX_LIVE_SYNC_DURATION / fragmentDuration
    );
    const newLiveSyncDurationCount = Math.min(
      data.details.fragments.length - 1,
      maxLiveSyncCount
    );
    if (this.currentHlsInstance && this.currentHlsInstance.config.liveSyncDurationCount !== newLiveSyncDurationCount) {
      this.debug(
        `Setting liveSyncDurationCount to ${newLiveSyncDurationCount}`
      );
      this.currentHlsInstance.config.liveSyncDurationCount = newLiveSyncDurationCount;
    }
  }
  handleMediaAttached = () => {
    this.updateMediaElementEventHandlers("register");
  };
  handleMediaDetached = () => {
    this.updateMediaElementEventHandlers("unregister");
  };
  handlePlaybackUpdate = (event) => {
    const media = event.target;
    this.core.updatePlayback(media.currentTime, media.playbackRate);
  };
  destroyCore = () => this.core.destroy();
  destroy = () => {
    this.destroyCore();
    this.updateHlsEventsHandlers("unregister");
    this.updateMediaElementEventHandlers("unregister");
    this.currentHlsInstance = void 0;
  };
  createFragmentLoaderClass() {
    const { core } = this;
    const engine = this;
    return class FragmentLoader extends FragmentLoaderBase {
      constructor(config) {
        super(config, core);
      }
      static getEngine() {
        return engine;
      }
    };
  }
  createPlaylistLoaderClass() {
    const engine = this;
    return class PlaylistLoader extends PlaylistLoaderBase {
      constructor(config) {
        super(config);
        engine.initHlsEvents();
      }
    };
  }
}
export {
  HlsJsP2PEngine
};
//# sourceMappingURL=p2p-media-loader-hlsjs.es.js.map
