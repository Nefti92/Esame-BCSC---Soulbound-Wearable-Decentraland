import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import faceOverlay from "./assets/images/face_overlay.png"
import { BrowserProvider, Contract } from "ethers";
import "./App.css"

// === CONFIG CONTRACTS (Sepolia) ===
const PBT_CONTRACT = "0x1658f712EFdA21b5F0047eB851B29a23e24aa3aF";
const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";
const PBT_SINK = "0x000000000000000000000000000000000000dEaD" // “burn” sink

const REGISTRY_ADDR = "0x5af3537aC6Bb097E1e14d53323795620DC31d33E";
const REGISTRY_ABI = [
  "function setMaskData(string newPhoto, string newMask) public",
  "function getMaskData(address account) view returns (string,string)",
  "event MaskDataUpdated(address account, string oldPhoto, string oldMask, string newPhoto, string newMask)"
];

const SOULBOUND_ADDR = "0x50521944877200eA49B337e302752430045E02f1";
const SOULBOUND_ABI = [
  "function safeMint(address to, string uri) public",
  "function getUserToken(address user) view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)"
];

const IPFS_GATEWAY = "bronze-adequate-lobster-570.mypinata.cloud";
const toGateway = (u: string) =>
  u?.startsWith("ipfs://") ? `https://${IPFS_GATEWAY}/ipfs/${u.slice(7)}` : u;

// === CONFIG BACKEND (Server.js) ===

const API_BASE = "http://localhost:5000";

// ---- Tipi minimi EIP-1193/MetaMask ----
type Ethereum = {
  isMetaMask?: boolean
  request: (args: { method: string; params?: any[] | object }) => Promise<any>
  on: (event: string, handler: (...args: any[]) => void) => void
  removeListener: (event: string, handler: (...args: any[]) => void) => void
}

declare global {
  interface Window {
    ethereum?: Ethereum
  }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, content] = dataUrl.split(",");
  const mime = meta.match(/:(.*?);/)?.[1] ?? "image/png";
  const bin = atob(content);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function saveTemporaryPhotoFromDataUrl(dataUrl: string) {
  const blob = dataUrlToBlob(dataUrl);
  const fd = new FormData();
  fd.append("photo", blob, "photo.png");
  const res = await fetch(`${API_BASE}/saveTemporaryPhoto`, {
    method: "POST",
    body: fd
  });
  if (!res.ok) throw new Error("Errore caricamento foto sul server");
  return res.json();
}

async function runBlenderScript() {
  const res = await fetch(`${API_BASE}/run-blender`);
  if (!res.ok) throw new Error("Errore esecuzione Blender");
  return res.text();
}

async function getAccount() {
  const eth = window.ethereum!;
  let accs: string[] = await eth.request({ method: 'eth_accounts' });
  if (!accs?.length) accs = await eth.request({ method: 'eth_requestAccounts' });
  if (!accs?.length) throw new Error('Wallet non connesso');
  return accs[0];
}

async function ensureSepolia() {
  const eth = window.ethereum!;
  const chainId = await eth.request({ method: "eth_chainId" });
  if (chainId !== SEPOLIA_CHAIN_ID_HEX) {
    throw new Error("Sei su una rete diversa da Sepolia");
  }
}

async function uploadFilesAndMetadata() {
  const account = await getAccount();

  // 1) upload file a Pinata
  const up = await fetch(`${API_BASE}/uploadTemporaryFilesToIPFS`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account }),
  });
  if (!up.ok) throw new Error('Upload su IPFS fallito: ' + await up.text());
  const upJson = await up.json();

  // Supporta entrambe le forme:
  // A) { photoCid, maskCid, ... }
  // B) { cids: [{file:'photo_<acc>.png', cid:'...'}, {file:'mask_<acc>.glb', cid:'...'}] }
  let photoCid: string | undefined;
  let maskCid: string | undefined;

  if ('photoCid' in upJson && 'maskCid' in upJson) {
    photoCid = upJson.photoCid;
    maskCid = upJson.maskCid;
  } else if (Array.isArray(upJson.cids)) {
    for (const item of upJson.cids) {
      if (typeof item?.file === 'string' && typeof item?.cid === 'string') {
        if (item.file.startsWith('photo_')) photoCid = item.cid;
        if (item.file.startsWith('mask_'))  maskCid  = item.cid;
      }
    }
  }

  if (!photoCid || !maskCid) {
    throw new Error('Upload IPFS: risposta inattesa, niente CID: ' + JSON.stringify(upJson));
  }

  // 2) crea metadata su Pinata
  const meta = await fetch(`${API_BASE}/createAndUploadMetadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photoCid, maskCid, account }),
  });
  if (!meta.ok) throw new Error('Creazione metadata fallita: ' + await meta.text());
  const { cid: metadataCid } = await meta.json();

  return {
    photoCid,
    maskCid,
    metadataCid,
  };
}

async function setMaskDataOnChain(photoCid: string, maskCid: string) {
  await ensureSepolia();
  const provider = new BrowserProvider(window.ethereum as any);
  const signer = await provider.getSigner();

  const registry = new Contract(REGISTRY_ADDR, REGISTRY_ABI, signer);

  const tx = await registry.setMaskData(photoCid, maskCid);
  const receipt = await tx.wait();

  // Verifica on-chain
  const account = await getAccount();
  const [onchainPhoto, onchainMask] = await registry.getMaskData(account);

  return {
    txHash: receipt?.hash ?? tx.hash,
    photoCidSaved: onchainPhoto,
    maskCidSaved: onchainMask,
  };
}

async function mintSoulbound(metadataCid: string) {
  await ensureSepolia();
  const account = await getAccount();

  const provider = new BrowserProvider(window.ethereum as any);
  const signer = await provider.getSigner();
  const sb = new Contract(SOULBOUND_ADDR, SOULBOUND_ABI, signer);

  const tokenUri = `ipfs://${metadataCid}`;

  const tx = await sb.safeMint(account, tokenUri);
  const receipt = await tx.wait();

  const tokenId = await sb.getUserToken(account);
  const onchainUri = await sb.tokenURI(tokenId);

  return {
    txHash: receipt.hash,
    tokenId: tokenId.toString(),
    onchainUri,
    explorer: `https://sepolia.etherscan.io/tx/${receipt.hash}`
  };
}


// =====================
// Component: WebcamCard
// =====================
function WebcamCard({ onConfirmSelection }: { onConfirmSelection: (dataUrl: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [spending, setSpending] = useState(false)
  const [sessionShotsLeft, setSessionShotsLeft] = useState(0)
  const [startingSession, setStartingSession] = useState(false)
  const [shots, setShots] = useState<string[]>([])
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [showOverlay, setShowOverlay] = useState(true)
  const [overlayOpacity, setOverlayOpacity] = useState(0.7) // 0..1
  type DirHandle = any
  const [dirHandle, setDirHandle] = useState<DirHandle | null>(null)

  // prompt per scegliere la cartella una volta
  const pickDirectory = async () => {
    // @ts-ignore
    if (!window.showDirectoryPicker) {
      alert("Il tuo browser non supporta la scelta cartella. Usa Chrome/Edge desktop.")
      return
    }
    // @ts-ignore
    const handle = await window.showDirectoryPicker()
    if (!(await verifyPermission(handle, 'readwrite'))) {
      alert("Permesso di scrittura negato per la cartella selezionata.")
      return
    }
    setDirHandle(handle)
  }

  // Crea (se serve) e ritorna una sottocartella del dir selezionato
  async function ensureSubdir(parentDir: any, name: string) {
    const ok = await verifyPermission(parentDir, 'readwrite')
    if (!ok) throw new Error("Permesso write negato sulla cartella scelta")
    return parentDir.getDirectoryHandle(name, { create: true })
  }

  // Copia un file (snapshot_X.png) in temporary_photo/photo.png
  async function copySnapshotToTempFolder(
    sourceFileName: string,
    subdirName = "temporary_files",
    destFileName = "photo.png"
  ) {
    if (!dirHandle) throw new Error("Nessuna cartella selezionata")
    // 1) apri il file sorgente
    const srcHandle = await dirHandle.getFileHandle(sourceFileName, { create: false })
    const srcFile = await srcHandle.getFile()
    // 2) crea/ottieni la sottocartella
    const tempDir = await ensureSubdir(dirHandle, subdirName)
    // 3) crea (o sovrascrivi) il file destinazione
    const dstHandle = await tempDir.getFileHandle(destFileName, { create: true })
    const writable = await dstHandle.createWritable()
    // 4) scrivi i byte del sorgente
    const buf = await srcFile.arrayBuffer()
    await writable.write(new Uint8Array(buf))
    await writable.close()
  }

  // Verifica/richiede permessi sulla cartella
  async function verifyPermission(dir: any, mode: 'read' | 'readwrite' = 'readwrite') {
    if (!dir?.queryPermission || !dir?.requestPermission) return false
    let p = await dir.queryPermission({ mode })
    if (p === 'granted') return true
    if (p === 'prompt') {
      p = await dir.requestPermission({ mode })
      return p === 'granted'
    }
    return false
  }


  const resetSnapshots = async () => {
    if (!dirHandle) return
    if (!('removeEntry' in dirHandle)) {
      alert("La cancellazione file non è supportata in questo browser.")
      return
    }
    const ok = await verifyPermission(dirHandle, 'readwrite')
    if (!ok) {
      alert("Permesso di scrittura mancante. Riapri la cartella con 'Scegli cartella'.")
      return
    }

    for (let i = 1; i <= 3; i++) {
      const name = `snapshot_${i}.png`
      try {
        await dirHandle.removeEntry(name, { recursive: false })
      } catch (e: any) {
        // Se il file non esiste, ignora; altri errori, segnalali
        if (e?.name === 'NotFoundError') continue
        console.error(`Errore cancellando ${name}:`, e)
        throw e
      }
    }
  }


  // Salva uno snapshot con nome fisso usando FS Access API
  const saveSnapshotToDir = async (fileName: string, dataUrl: string) => {
    if (!dirHandle) return false
    try {
      const fh = await dirHandle.getFileHandle(fileName, { create: true })
      const w = await fh.createWritable()
      // dataURL -> Blob
      const [header, data] = dataUrl.split(",")
      const mime = header.match(/:(.*?);/)?.[1] || "image/png"
      const bin = atob(data)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      await w.write(new Blob([arr], { type: mime }))
      await w.close()
      return true
    } catch {
      return false
    }
  }

  const encodeTransfer = (to: string, amount: bigint) => {
    const method = "0xa9059cbb" // transfer(address,uint256)
    const toPadded = to.toLowerCase().replace(/^0x/, "").padStart(64, "0")
    const amtPadded = amount.toString(16).padStart(64, "0")
    return method + toPadded + amtPadded
  }

  const waitForReceipt = async (txHash: string, pollMs = 1500) => {
    const eth = window.ethereum!
    for (;;) {
      const receipt = await eth.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      })
      if (receipt) return receipt
      await new Promise(r => setTimeout(r, pollMs))
    }
  }

  const spendOnePbt = async () => {
    const eth = window.ethereum
    if (!eth) throw new Error("MetaMask non disponibile")
    const [acc] = (await eth.request({ method: "eth_accounts" })) as string[]
    if (!acc) throw new Error("Wallet non connesso")
    const chainId = (await eth.request({ method: "eth_chainId" })) as string
    if (chainId !== SEPOLIA_CHAIN_ID_HEX) throw new Error("Sei su una rete diversa da Sepolia")

    const txData = encodeTransfer(PBT_SINK, 1n)
    setSpending(true)
    try {
      const txHash = (await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: acc, to: PBT_CONTRACT, data: txData, value: "0x0" }],
      })) as string
      return txHash
    } finally {
      setSpending(false)
    }
  }


  
  const constraints = useMemo<MediaStreamConstraints>(
    () => ({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }),
    []
  )

  const startCamera = useCallback(async () => {
    setError(null)
    setIsStarting(true)
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints)
      setStream(s)
      if (videoRef.current) {
        videoRef.current.srcObject = s
        await videoRef.current.play().catch(() => {})
      }
    } catch (e: any) {
      const msg =
        e?.name === "NotAllowedError" ? "Permesso videocamera negato." :
        e?.name === "NotFoundError" ? "Nessuna videocamera trovata." :
        "Impossibile avviare la videocamera."
      setError(`${msg} ${e?.message ?? ""}`)
    } finally {
      setIsStarting(false)
    }
  }, [constraints])

    const stopCamera = useCallback(() => {
    stream?.getTracks().forEach((t) => t.stop())
    setStream(null)
    if (videoRef.current) videoRef.current.srcObject = null
  }, [stream])

  useEffect(() => {
    return () => { stream?.getTracks().forEach((t) => t.stop()) }
  }, [stream])

  const takePhoto = useCallback(async () => {
    if (!videoRef.current || sessionShotsLeft <= 0) return
    if (!dirHandle) {
      alert("Seleziona prima una cartella dove salvare le foto.")
      return
    }

    const video = videoRef.current
    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL("image/png")

    const index = 3 - sessionShotsLeft
    const fileName = `snapshot_${index + 1}.png`

    const saved = await saveSnapshotToDir(fileName, dataUrl)
    if (!saved) {
      alert("Salvataggio non riuscito. Controlla i permessi della cartella.")
      return
    }

    setSnapshot(dataUrl)                 // ultimo scatto (puoi tenerlo per compatibilità)
    setShots(prev => [...prev, dataUrl]) // ⬅️ accumula scatti
    setSessionShotsLeft(n => Math.max(0, n - 1))
  }, [sessionShotsLeft, dirHandle])


    const startPhotoSession = async () => {
    if (!dirHandle) {
      alert("Seleziona prima una cartella (pulsante 'Scegli cartella').")
      return
    }
    try {
      setStartingSession(true)
      const txHash = await spendOnePbt()
      await waitForReceipt(txHash)
      window.dispatchEvent(new Event("pbt:changed"))

      await resetSnapshots()

      setSnapshot(null)
      setShots([])              // ⬅️ reset galleria
      setSelectedIdx(null)      // ⬅️ reset selezione
      setSessionShotsLeft(3)
    } catch (e: any) {
      alert(e?.message ?? "Impossibile avviare la sessione (1 PBT)")
    } finally {
      setStartingSession(false)
    }
  }



  const cameraActive = Boolean(stream)
  const showGallery = sessionShotsLeft === 0 && shots.length === 3

  return (
    <div className="card">
      <div className="card-header">
        <h2>Webcam</h2>
        <div className="card-actions">
          <button className="btn secondary" onClick={pickDirectory}>
            {dirHandle ? "Cartella selezionata ✓" : "Scegli cartella"}
          </button>

          {!cameraActive ? (
            <button className="btn" onClick={startCamera} disabled={isStarting}>
              {isStarting ? "Avvio..." : "Avvia fotocamera"}
            </button>
          ) : sessionShotsLeft > 0 ? (
            <>
              <button className="btn secondary" onClick={stopCamera}>Spegni</button>
              <button className="btn" onClick={takePhoto} disabled={!dirHandle}>
                Scatta foto ({sessionShotsLeft}/3)
              </button>
            </>
          ) : (
            <>
              <button className="btn secondary" onClick={stopCamera}>Spegni</button>
              <button
                className="btn"
                onClick={startPhotoSession}
                disabled={startingSession || !dirHandle}
                title={!dirHandle ? "Seleziona una cartella prima" : undefined}
              >
                {startingSession ? "Autorizzazione..." : "Avvia sessione (3 scatti · 1 PBT)"}
              </button>
            </>
          )}
        </div>
        <label className="overlay-ctrl">
          <input
            type="checkbox"
            checked={showOverlay}
            onChange={(e) => setShowOverlay(e.target.checked)}
          />
          Overlay
        </label>

        {showOverlay && (
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={overlayOpacity}
            onChange={(e) => setOverlayOpacity(Number(e.target.value))}
            aria-label="Opacità overlay"
            className="overlay-range"
          />
        )}

      </div>

      {/* Video area */}
      <div className="video-shell">
        {!cameraActive && (
          <div className="overlay">
            <img src="./src/assets/images/placeholder.png" alt="Segnaposto" />
            <p>Clicca “Avvia fotocamera” per attivare lo stream</p>
          </div>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`video ${cameraActive ? "visible" : "hidden"}`}
        />

        {/* Overlay volto */}
        {cameraActive && showOverlay && (
          <img
            src={faceOverlay}
            alt=""
            aria-hidden="true"
            className="camera-overlay"
            style={{ opacity: overlayOpacity }}
          />
        )}
      </div>

      {/* Ultimo scatto (opzionale) */}
      {snapshot && !showGallery && (
        <div style={{ marginTop: 10 }}>
          <span className="label">Ultima foto:</span>
          <img
            src={snapshot}
            alt="snapshot"
            style={{ width: "100%", marginTop: 6, borderRadius: 8 }}
          />
        </div>
      )}

      {/* Galleria con selezione */}
      {showGallery && (
        <div style={{ marginTop: 12 }}>
          <span className="label">Scegli una delle 3 foto:</span>
          <div className="thumbs">
            {shots.map((s, i) => (
              <button
                key={i}
                className={`thumb ${selectedIdx === i ? "selected" : ""}`}
                onClick={() => setSelectedIdx(i)}
                aria-pressed={selectedIdx === i}
              >
                <img src={s} alt={`scatto ${i + 1}`} />
                <div className="thumb-tag">{i + 1}</div>
              </button>
            ))}
          </div>

          <div style={{ marginTop: 10 }}>
            <button
              className="btn"
              disabled={selectedIdx === null}
              onClick={async () => {
                if (selectedIdx === null) return
                try {
                  // deduci il nome del file sorgente in base all’indice scelto (1..3)
                  const srcName = `snapshot_${selectedIdx + 1}.png`
                  await copySnapshotToTempFolder(srcName, "temporary_photo", "photo.png")
                  // continua con il tuo flusso (pagina review, ecc.)
                  onConfirmSelection(shots[selectedIdx])
                  alert("Foto copiata in temporary_photo/photo.png ✓")
                } catch (e: any) {
                  alert("Copia fallita: " + (e?.message ?? "errore sconosciuto"))
                }
              }}
            >
              Conferma selezione
            </button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
    </div>
  )
}
// =========================
// Component: WalletMetaMask
// =========================
function WalletMetaMask() {
  const [hasMM, setHasMM] = useState<boolean>(false)
  const [account, setAccount] = useState<string | null>(null)
  const [chainId, setChainId] = useState<string | null>(null)
  const [balanceEth, setBalanceEth] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  const [pbtBalance, setPbtBalance] = useState<string | null>(null);

  const ethCall = async (to: string, data: string) => {
    const eth = window.ethereum!;
    return eth.request({
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }) as Promise<string>;
  };

  // encode balanceOf(address): 0x70a08231 + 12 byte padding + address
  const encodeBalanceOf = (addr: string) =>
    "0x70a08231" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

  // decimals(): 0x313ce567
  const FN_DECIMALS = "0x313ce567";

  const fetchPbtBalance = async (accountAddr: string) => {
    if (!PBT_CONTRACT || !accountAddr) {
      setPbtBalance(null)
      return
    }
    try {
      // 1) decimals (gestisce correttamente 0)
      const decHex = await ethCall(PBT_CONTRACT, FN_DECIMALS)
      const decParsed = Number.parseInt(decHex, 16)
      const decimals = Number.isNaN(decParsed) ? 18 : decParsed

      // 2) balanceOf(account)
      const balHex = await ethCall(PBT_CONTRACT, encodeBalanceOf(accountAddr))
      const raw = BigInt(balHex) // es. 13n

      // format con i decimals
      if (decimals === 0) {
        setPbtBalance(raw.toString()) // intero puro (niente virgola)
        return
      }
      const divisor = BigInt(10) ** BigInt(decimals)
      const intPart = (raw / divisor).toString()
      const fracPartRaw = (raw % divisor).toString().padStart(decimals, "0")
      const fracTrim = fracPartRaw.replace(/0+$/, "").slice(0, 6)
      setPbtBalance(fracTrim ? `${intPart}.${fracTrim}` : intPart)
    } catch {
      setPbtBalance(null)
    }
  }


  useEffect(() => {
    const eth = window.ethereum
    setHasMM(Boolean(eth?.isMetaMask || eth))
  }, [])

  const fetchState = useCallback(async (acc?: string[]) => {
    const eth = window.ethereum;
    if (!eth) return;
    try {
      const accounts: string[] = acc ?? (await eth.request({ method: "eth_accounts" }));
      const cId: string = await eth.request({ method: "eth_chainId" });
      setChainId(cId);

      if (accounts && accounts.length > 0) {
        const a = accounts[0];
        setAccount(a);
        const balHex: string = await eth.request({
          method: "eth_getBalance",
          params: [a, "latest"],
        });
        const bal = parseInt(balHex, 16) / 1e18;
        setBalanceEth(bal.toFixed(6));

        // PBT solo su Sepolia
        if (cId === SEPOLIA_CHAIN_ID_HEX) {
          await fetchPbtBalance(a);
        } else {
          setPbtBalance(null);
        }
      } else {
        setAccount(null);
        setBalanceEth(null);
        setPbtBalance(null);
      }
    } catch (e: any) {
      setError(e?.message ?? "Errore nel leggere stato del wallet");
    }
  }, []);

  
  useEffect(() => {
    const onChanged = () => { void fetchState() }
    window.addEventListener("pbt:changed", onChanged)
    return () => window.removeEventListener("pbt:changed", onChanged)
  }, [fetchState])

  const connect = useCallback(async () => {
    setError(null)
    setConnecting(true)
    try {
      const eth = window.ethereum
      if (!eth) {
        setHasMM(false)
        setError("MetaMask non rilevato.")
        return
      }
      const accounts: string[] = await eth.request({
        method: "eth_requestAccounts"
      })
      await fetchState(accounts)
    } catch (e: any) {
      setError(e?.message ?? "Connessione rifiutata o fallita.")
    } finally {
      setConnecting(false)
    }
  }, [fetchState])

  useEffect(() => {
    const eth = window.ethereum
    if (!eth) return

    const onAccounts = (accs: string[]) => fetchState(accs)
    const onChain = (_cid: string) => fetchState()

    eth.on("accountsChanged", onAccounts)
    eth.on("chainChanged", onChain)

    fetchState()

    return () => {
      eth.removeListener("accountsChanged", onAccounts)
      eth.removeListener("chainChanged", onChain)
    }
  }, [fetchState])

  return (
    <div>
      {!hasMM && (
        <div className="warning" style={{ marginBottom: 12 }}>
          MetaMask non è installato. Installa l’estensione e ricarica la pagina.
        </div>
      )}

      <div className="wallet-grid">
        <div>
          <span className="label">Account</span>
          <div className="mono">{account ?? "—"}</div>
        </div>
        <div>
          <span className="label">Chain ID</span>
          <div className="mono">{chainId ?? "—"}</div>
        </div>
        <div>
          <span className="label">Balance</span>
          <div className="mono">{balanceEth ? `${balanceEth} ETH` : "—"}</div>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <span className="label">Token PBT (Sepolia)</span>
          <div className="mono">
            {chainId !== SEPOLIA_CHAIN_ID_HEX
              ? "Passa a Sepolia per vedere PBT"
              : pbtBalance !== null
              ? `${pbtBalance} PBT`
              : "—"}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        {!account ? (
          <button className="btn" onClick={connect} disabled={connecting}>
            {connecting ? "Connessione..." : "Connetti Wallet"}
          </button>
        ) : (
          <span className="pill">Connesso</span>
        )}
      </div>

      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}

      <ul className="hints">
        <li>Puoi cambiare rete da MetaMask: si aggiorna automaticamente.</li>
        <li>
          Per test su <strong>Sepolia</strong>, passa a chainId <code>0xaa36a7</code>.
        </li>
      </ul>
    </div>
  )
}

// ===================
// Component: Drawer
// ===================
function RightDrawer({
  open,
  onClose,
  title,
  children
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    if (open) document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  return (
    <>
      <div
        className={`drawer-backdrop ${open ? "show" : ""}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`drawer ${open ? "open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="drawer-header">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi">
            ✕
          </button>
        </div>
        <div className="drawer-content">{children}</div>
      </aside>
    </>
  )
}

function SelectedPhotoPage({
  dataUrl,
  onBack
}: {
  dataUrl: string
  onBack: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tokenId, setTokenId] = useState<string | null>(null)
  const [tokenUri, setTokenUri] = useState<string | null>(null)
  const [meta, setMeta] = useState<any | null>(null)

  const loadMetadata = async () => {
    try {
      setLoading(true)
      setError(null)
      const provider = new BrowserProvider(window.ethereum as any)
      const signer = await provider.getSigner()
      const account = await signer.getAddress()

      const sb = new Contract(SOULBOUND_ADDR, SOULBOUND_ABI, signer)
      const tid = (await sb.getUserToken(account)) as bigint
      if (tid === 0n) {
        throw new Error("Nessun soulbound token trovato per questo account.")
      }
      const uri = (await sb.tokenURI(tid)) as string

      const metaUrl = toGateway(uri)
      const resp = await fetch(metaUrl)
      if (!resp.ok) throw new Error("Impossibile scaricare i metadati da IPFS")
      const json = await resp.json()

      setTokenId(tid.toString())
      setTokenUri(uri)
      setMeta(json)
    } catch (e: any) {
      setError(e?.message ?? "Errore nel caricamento dei metadati")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2>Foto selezionata</h2>
        <div className="card-actions">
          <button className="btn secondary" onClick={onBack}>Indietro</button>
          <button className="btn" onClick={loadMetadata} disabled={loading}>
            {loading ? "Carico metadati..." : "Mostra metadati SBT"}
          </button>
        </div>
      </div>

      <img src={dataUrl} alt="selected" style={{ width: "100%", borderRadius: 12 }} />

      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}

      {tokenId && tokenUri && meta && (
        <div className="meta-panel" style={{ marginTop: 16 }}>
          <div className="label">Token ID</div>
          <div className="mono">{tokenId}</div>

          <div className="label" style={{ marginTop: 8 }}>tokenURI</div>
          <div className="mono" style={{ wordBreak: "break-all" }}>{tokenUri}</div>
          <a className="btn secondary" style={{ marginTop: 8 }} href={toGateway(tokenUri)} target="_blank" rel="noreferrer">
            Apri metadata JSON
          </a>

          {meta.name && (
            <>
              <div className="label" style={{ marginTop: 12 }}>Nome</div>
              <div>{meta.name}</div>
            </>
          )}
          {meta.description && (
            <>
              <div className="label" style={{ marginTop: 8 }}>Descrizione</div>
              <div>{meta.description}</div>
            </>
          )}

          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {meta.image && (
              <a className="btn" href={toGateway(meta.image)} target="_blank" rel="noreferrer">
                Apri foto (image)
              </a>
            )}
            {meta.animation_url && (
              <a className="btn" href={toGateway(meta.animation_url)} target="_blank" rel="noreferrer">
                Apri maschera GLB (animation_url)
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}


// ============
// App Layout
// ============
// ============
// App Layout
// ============
export default function App() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [page, setPage] = useState<"camera" | "review">("camera")
  const [chosen, setChosen] = useState<string | null>(null)

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar-left">
          <h1>Webcam + MetaMask</h1>
          <p className="subtitle">Avvia la fotocamera e collega il wallet.</p>
        </div>

        <div className="topbar-right">
          <button
            className="btn wallet-btn"
            onClick={() => setDrawerOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            aria-controls="wallet-drawer"
          >
            Wallet
          </button>
        </div>
      </header>

      <main className="grid">
        {page === "camera" ? (
          <WebcamCard
            onConfirmSelection={async (dataUrl) => {
              try {
                await saveTemporaryPhotoFromDataUrl(dataUrl);     // -> temporary_files/photo.png
                await runBlenderScript();                         // -> temporary_files/mask.glb

                const { photoCid, maskCid, metadataCid } = await uploadFilesAndMetadata();

                // 1) se usi il registro:
                await setMaskDataOnChain(photoCid, maskCid);

                // 2) mint soulbound
                const mintRes = await mintSoulbound(metadataCid);
                console.log("Soulbound minted:", mintRes);
                alert(`Mint OK! Token #${mintRes.tokenId}\nTx: ${mintRes.explorer}`);

                setChosen(dataUrl);
                setPage("review");
              } catch (e: any) {
                alert("Errore mint soulbound: " + (e?.message ?? ""));
              }
            }}
          />
        ) : (
          <SelectedPhotoPage
            dataUrl={chosen!}
            onBack={() => setPage("camera")}
          />
        )}
      </main>

      <div id="wallet-drawer">
        <RightDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="MetaMask"
        >
          <WalletMetaMask />
        </RightDrawer>
      </div>
    </div>
  )
}

