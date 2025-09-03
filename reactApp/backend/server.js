const express = require('express'); // Importa Express per creare il server.
const multer = require('multer'); // Importa Multer per gestire il caricamento dei file
const cors = require('cors'); // Importa CORS per gestire le richieste cross-origin
const axios = require('axios');
const fs = require('fs'); // Importa il modulo fs per interagire il locale
const { exec } = require('child_process'); // Importa exec per eseguire comandi esterni (script blender)
const path = require('path'); // Importa il modulo path per gestire i percorsi dei file
const FormData = require('form-data');
const bodyParser = require('body-parser');

const app = express(); // Creazione applicazione Express.
const PORT = 5000; // Porta ascolto server

app.use(cors()); // Abilita CORS 
app.use(express.json()); // Abilitazione richieste json
app.use(express.urlencoded({ extended: true }));  // Abilitazione form
app.use(bodyParser.json());

app.use(cors({
  origin: 'http://localhost:5173' 
}));

const temporaryFiles = 'temporary_files'; // Directory in cui salvare le immagini caricate.

// Parametri Pinata configurabili
const PINATA_API_KEY = '4e26bc6fb781181e4299';
const PINATA_SECRET_API_KEY = '16fefb5c3b8879293ae7c86055372f6dd25b2b2f8af6d549ce58dd719855aedf';
const IPFS_BASE_URL = 'bronze-adequate-lobster-570.mypinata.cloud'; 

if (!fs.existsSync(temporaryFiles)) { 
  fs.mkdirSync(temporaryFiles);
}

//----------------------------------SALVATAGGIO LOCALE-----------------------------------------------------

const storage = multer.diskStorage({ // Configura la gestione dei file caricati con multer
  destination: (req, file, cb) => {   
    cb(null, temporaryFiles); // Cartella uploads dove salvare
  },
  filename: (req, file, cb) => {      
    // Salvataggio temporaneo
    cb(null, `temp_${Date.now()}${path.extname(file.originalname)}`); 
  },
});

const upload = multer({ storage: storage }); // Configurazione multer

// Funzione upload foto
app.post('/saveTemporaryPhoto', upload.single('photo'), (req, res) => { 

  try {

    const tempPath = req.file.path; // Ottiene il percorso temporaneo del file caricato.

    // Aggiunge l'estensione .png al file
    const targetPath = path.join(temporaryFiles, 'photo.png'); // Percorso finale del file rinominato.

    fs.rename(tempPath, targetPath, (err) => { // Rinomina il file temporaneo con l'hash fornito.
      if (err) throw err;                       
      console.log(`Foto salvata come: ${targetPath}`); // Conferma il salvataggio.
      res.json({ message: 'Foto caricata e salvata con successo' }); // Messaggio conferma per frontend
    });

  } catch (error) {
    console.error('Errore durante il caricamento della foto:', error);  
    res.status(500).json({ message: 'Errore durante il caricamento della foto' }); // Risponde con un errore al frontend
  }
});

//----------------------------------ESECUZIONE BLENDER-----------------------------------------------------

const command=".\\command.ps1" // Percorso file comando da eseguire

// Funzione per l'esecuzione del comando dello script blender
app.get('/run-blender', (req, res) => {   
  exec(command, { shell: 'powershell.exe' }, (error, stdout, stderr) => { 
    if (error) {  // Gestione errore
      console.error(`Errore esecuzione comando: ${error.message}`);
      return res.status(500).send('Errore esecuzione comando');
    }
    if (stderr) { // Errori Blender
      console.error(`stderr: ${stderr}`);
      return res.status(500).send('Errore esecuzione comando');
    }
    console.log(`Messaggi Blender: ${stdout}`); // Output Blender.
    res.send('Comando eseguito con successo');   
  });
});

app.listen(PORT, () => {    
  console.log(`Server in esecuzione su http://localhost:${PORT}`); // Server in esecuzione
});

//----------------------------------CARICAMENTO SU PINATA FOTO E MASCHERA-----------------------------------------------------

// Caricamento su Pinata
app.post('/uploadTemporaryFilesToIPFS', async (req, res) => {
  const { account } = req.body; // Otteniamo il nome dell'account dal corpo della richiesta

  try {
    if (!account) {
      throw new Error('Account non fornito');
    }

    const directory = path.join(__dirname, 'temporary_files'); // Percorso della cartella temporanea
    const files = [
      { name: `photo_${account}.png`, original: 'photo.png' },
      { name: `mask_${account}.glb`, original: 'mask.glb' }
    ]; // Array dei file con il nome rinominato

    const uploadedCIDs = []; // Array per salvare i CID di entrambi i file

    for (const file of files) {
      const originalFilePath = path.join(directory, file.original);
      const renamedFilePath = path.join(directory, file.name);

      // Rinomina i file temporanei con il nome dell'account
      if (fs.existsSync(originalFilePath)) {
        fs.renameSync(originalFilePath, renamedFilePath); // Rinomina il file

        const formData = new FormData();
        formData.append('file', fs.createReadStream(renamedFilePath));

        const url = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

        const pinataResponse = await axios.post(url, formData, {
          maxContentLength: 'Infinity',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${formData._boundary}`,
            pinata_api_key: PINATA_API_KEY,
            pinata_secret_api_key: PINATA_SECRET_API_KEY,
          },
        });

        const cid = pinataResponse.data.IpfsHash;
        console.log('CID per', file.name, ':', cid);
        uploadedCIDs.push({ file: file.name, cid });
      } else {
        throw new Error(`File ${file.original} non trovato nella cartella temporary_files`);
      }
    }

    // Elimina solo i file all'interno della cartella temporary_files
    removeFilesInDirectory(directory);

    // Invia i CID al frontend
    res.json({ cids: uploadedCIDs });
  } catch (error) {
    console.error('Errore durante il caricamento su IPFS:', error);
    res.status(500).send('Errore durante il caricamento su IPFS');
  }
});

// Funzione per rimuovere solo i file nella cartella
const removeFilesInDirectory = (directoryPath) => {
  fs.readdir(directoryPath, (err, files) => {
    if (err) {
      console.error('Errore nella lettura della cartella:', err);
      return;
    }

    files.forEach(file => {
      const filePath = path.join(directoryPath, file);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error(`Errore nella rimozione del file ${file}:`, err);
        } else {
          console.log(`File ${file} eliminato con successo`);
        }
      });
    });
  });
};

//----------------------------------ELIMINAZIONE DA PINATA-----------------------------------------------------

// Endpoint per l'unpinning di un file su Pinata
app.delete('/unpinFileFromIPFS/:cid', async (req, res) => {
  const { cid } = req.params; // Ottieni il CID dai parametri della richiesta

  try {
    const url = `https://api.pinata.cloud/pinning/unpin/${cid}`; // URL per l'unpin

    // Effettua la richiesta DELETE all'API di Pinata
    const pinataResponse = await axios.delete(url, {
      headers: {
        pinata_api_key: PINATA_API_KEY, 
        pinata_secret_api_key: PINATA_SECRET_API_KEY,
      },
    });

    console.log(`File con CID ${cid} rimosso con successo da Pinata.`);
    res.json({ message: `File con CID ${cid} rimosso con successo da Pinata`, result: pinataResponse.data });
  } catch (error) {
    console.error('Errore durante l\'unpinning del file su Pinata:', error.response?.data || error.message);
    res.status(500).json({ message: 'Errore durante l\'unpinning del file su Pinata', error: error.response?.data || error.message });
  }
});

//----------------------------------CREAZIONE E CARICAMENTO METADATI-----------------------------------------------------

// Funzione per caricare file su Pinata
const uploadToPinata = async (filePath) => {
  const url = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

  const data = new FormData();
  data.append('file', fs.createReadStream(filePath));

  const config = {
    headers: {
      'pinata_api_key': PINATA_API_KEY,
      'pinata_secret_api_key': PINATA_SECRET_API_KEY,
      ...data.getHeaders(),
    },
  };

  try {
    const response = await axios.post(url, data, config);
    return response.data.IpfsHash; // CID del file caricato
  } catch (error) {
    console.error('Errore nel caricamento su Pinata:', error);
    throw error;
  }
};

// Endpoint per ricevere i CID e generare il file JSON
app.post('/createAndUploadMetadata', async (req, res) => {
  const { photoCid, maskCid, account } = req.body;

  if (!photoCid || !maskCid || !account) {
    return res.status(400).json({ error: 'CID mancanti' });
  }

  // Struttura del JSON da creare
  const metadata = {
    name: "Token",
    description: "Prova Token",
    image: `https://${IPFS_BASE_URL}/ipfs/${photoCid}`,
    animation_url: `https://${IPFS_BASE_URL}/ipfs/${maskCid}`,
  };

  const filePath = path.join(__dirname, `metadata_${account}.json`);
  
  // Crea il file JSON
  fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2));

  try {
    // Carica il file JSON su Pinata
    const cid = await uploadToPinata(filePath);
    
    // Restituisci il CID del file JSON al frontend
    res.json({ cid });
  } catch (error) {
    res.status(500).json({ error: 'Errore nel caricamento su Pinata' });
  } finally {
    // Elimina il file temporaneo
    fs.unlinkSync(filePath);
  }
});
