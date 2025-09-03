import { engine, Name, pointerEventsSystem, InputAction } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/src/players'
import { createEthereumProvider } from '@dcl/sdk/ethereum-provider'
import { RequestManager, ContractFactory } from 'eth-connect'
import { openExternalUrl } from '~system/RestrictedActions'
import * as utils from '@dcl-sdk/utils'

// ====== CONFIG ======
const CONTRACT_ADDR = '0x1658f712EFdA21b5F0047eB851B29a23e24aa3aF'
const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7' // 11155111
const TOKEN_PRICE_WEI_HEX = '0x1'       // 1 wei esatto

// Apri questo URL quando si clicca l'oggetto "PhotoBooth"
const PHOTOBOOTH_URL = 'http://localhost:5173/'

// ABI minimale: buyToken() payable
const TICKET_ABI = [
  { inputs: [], name: 'buyToken', outputs: [], stateMutability: 'payable', type: 'function' }
]

let isBuying = false

export function main() {
  // === Registriamo il click sullo shop
  for (const [entity] of engine.getEntitiesWith(Name)) {
    const n = Name.get(entity)

    if (n?.value === 'ticket_shop') {
      pointerEventsSystem.onPointerDown(
        { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Compra 1 ticket (1 wei)' } },
        () => void onBuyTicket()
      )
    }

    // === click sull’oggetto "PhotoBooth" per aprire un sito esterno
    if (n?.value === 'PhotoBooth') {
      pointerEventsSystem.onPointerDown(
        { entity, opts: { button: InputAction.IA_PRIMARY, hoverText: 'Apri Photo Booth' } },
        () => {
          void openExternalUrl({ url: PHOTOBOOTH_URL })
        }
      )
    }
  }
}

async function onBuyTicket() {
  if (isBuying) return
  isBuying = true
  try {
    const user = getPlayer()
    if (user?.isGuest) {
      console.log('Utente guest: collega un wallet per procedere.')
      return
    }
    const from = user?.userId

    const provider: any = createEthereumProvider()
    const rm = new RequestManager(provider)

    let chainId: string
    try {
      chainId = await (rm as any).send({ method: 'eth_chainId', params: [] })
    } catch {
      chainId = await provider.request?.({ method: 'eth_chainId' })
    }

    if (!chainId || chainId.toLowerCase() !== SEPOLIA_CHAIN_ID_HEX) {
      try {
        await provider.request?.({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }]
        })
      } catch {
        try {
          await provider.request?.({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: SEPOLIA_CHAIN_ID_HEX,
              chainName: 'Sepolia',
              nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: ['https://rpc.sepolia.org'],
              blockExplorerUrls: ['https://sepolia.etherscan.io']
            }]
          })
          await provider.request?.({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }]
          })
        } catch {
          console.log('Seleziona manualmente la rete Sepolia nel tuo wallet e riprova.')
          return
        }
      }
    }

    const factory = new ContractFactory(rm, TICKET_ABI as any)
    const contract = (await factory.at(CONTRACT_ADDR)) as any

    const txHash: string = await contract.buyToken({ from, value: TOKEN_PRICE_WEI_HEX })
    console.log('Transazione inviata')

    // Polling receipt con utils.timers
    try {
      let receipt: any = null
      for (let i = 0; i < 20; i++) {
        receipt = await (rm as any).send({ method: 'eth_getTransactionReceipt', params: [txHash] })
        if (receipt && receipt.status) break
        await waitMs(3000)
      }
      if (receipt && receipt.status) console.log('Confermato!')
      else console.log('In attesa di conferma nel wallet…')
    } catch {
      console.log('Transazione inviata. Controlla lo stato nel wallet.')
    }
  } catch (err: any) {
    const msg = err?.message || String(err)
    if (msg.includes('wrong price')) console.error('Serve esattamente 1 wei.')
    else if (msg.toLowerCase().includes('user rejected')) console.log('Operazione annullata dall’utente.')
    else console.error('Errore acquisto ticket')
  } finally {
    isBuying = false
  }
}

// Helper: Promise-based timeout usando sdk7-utils
function waitMs(ms: number) {
  return new Promise<void>((resolve) => {
    utils.timers.setTimeout(() => resolve(), ms)
  })
}
