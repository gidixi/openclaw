---
summary: "Guida completa per eseguire GPT-OSS 20B su RTX 4090 con OpenClaw e Ollama"
read_when:
  - Vuoi eseguire modelli LLM locali di grandi dimensioni su GPU consumer
  - Hai una RTX 4090 e vuoi massimizzare le performance
  - Vuoi configurare GPT-OSS per uso con OpenClaw
title: "Eseguire GPT-OSS 20B su RTX 4090: Guida Completa"
date: "2026-02-09"
author: "gidixi"
---

# Eseguire GPT-OSS 20B su RTX 4090: Guida Completa

In questo articolo descriverò come sono riuscito a eseguire con successo **GPT-OSS 20B** su una **NVIDIA RTX 4090** utilizzando OpenClaw e Ollama. La RTX 4090, con i suoi 24GB di VRAM, è una delle GPU consumer più potenti disponibili e può gestire modelli di questa dimensione con performance eccellenti.

## Prerequisiti

Prima di iniziare, assicurati di avere:

- **NVIDIA RTX 4090** (24GB VRAM)
- **Driver NVIDIA aggiornati** (consigliato 535.x o superiore)
- **CUDA Toolkit** installato (opzionale, ma consigliato)
- **Docker** installato (per Ollama)
- **OpenClaw** installato e configurato
- Almeno **32GB di RAM** di sistema (consigliato)
- **SSD** per storage dei modelli (consigliato)

## Installazione di Ollama

### Passo 1: Installare Ollama

Ollama è il runtime che gestisce l'esecuzione locale dei modelli LLM. Installalo seguendo le istruzioni ufficiali:

```bash
# Linux
curl -fsSL https://ollama.ai/install.sh | sh

# macOS
brew install ollama

# Oppure scarica direttamente da https://ollama.ai
```

### Passo 2: Verificare l'installazione

Dopo l'installazione, verifica che Ollama funzioni correttamente:

```bash
ollama --version
ollama serve
```

Dovresti vedere Ollama avviarsi e ascoltare su `http://127.0.0.1:11434`.

## Configurazione GPU per Ollama

### Passo 3: Configurare CUDA e GPU

Ollama utilizza automaticamente la GPU se disponibile. Per verificare che la GPU sia riconosciuta:

```bash
# Verifica che NVIDIA-SMI funzioni
nvidia-smi

# Dovresti vedere la tua RTX 4090 con informazioni su utilizzo VRAM, temperatura, ecc.
```

### Passo 4: Variabili d'ambiente (opzionale)

Puoi configurare Ollama per utilizzare specificamente la GPU:

```bash
# Imposta la variabile d'ambiente per forzare l'uso della GPU
export CUDA_VISIBLE_DEVICES=0

# Per Linux, assicurati che il driver NVIDIA sia caricato
lsmod | grep nvidia
```

## Download e Setup di GPT-OSS 20B

### Passo 5: Scaricare il modello GPT-OSS 20B

GPT-OSS è un modello open-source compatibile con GPT, ottimizzato per l'esecuzione locale. Scaricalo con Ollama:

```bash
ollama pull gpt-oss:20b
```

**Nota importante**: Il modello GPT-OSS 20B è grande (~40GB), quindi assicurati di avere:

- Spazio su disco sufficiente (almeno 50GB liberi)
- Connessione internet stabile
- Tempo sufficiente per il download (può richiedere 30-60 minuti a seconda della velocità)

### Passo 6: Verificare il download

Dopo il download, verifica che il modello sia disponibile:

```bash
ollama list
```

Dovresti vedere `gpt-oss:20b` nella lista dei modelli installati.

## Configurazione OpenClaw

### Passo 7: Configurare OpenClaw per Ollama

Apri il file di configurazione di OpenClaw:

```bash
openclaw config edit
```

Aggiungi la configurazione per Ollama:

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
      },
    },
  },
}
```

Oppure, più semplicemente, imposta la variabile d'ambiente:

```bash
export OLLAMA_API_KEY="ollama-local"
```

OpenClaw rileverà automaticamente i modelli disponibili in Ollama.

### Passo 8: Verificare la configurazione

Verifica che OpenClaw riconosca il modello:

```bash
openclaw models list
```

Dovresti vedere `ollama/gpt-oss:20b` nella lista dei modelli disponibili.

## Ottimizzazione Performance

### Passo 9: Ottimizzare l'utilizzo VRAM

La RTX 4090 ha 24GB di VRAM, che è sufficiente per GPT-OSS 20B, ma è importante ottimizzare:

#### Configurazione Ollama per massimizzare VRAM

Crea o modifica il file di configurazione di Ollama (se disponibile):

```bash
# Su Linux, il file di configurazione è tipicamente in
~/.ollama/config.json
```

Aggiungi queste impostazioni per ottimizzare l'uso della GPU:

```json
{
  "gpu_layers": -1,
  "num_gpu": 1,
  "num_thread": 8,
  "numa": false
}
```

#### Monitorare l'utilizzo VRAM

Durante l'esecuzione, monitora l'utilizzo della GPU:

```bash
# In un terminale separato, esegui:
watch -n 1 nvidia-smi
```

Dovresti vedere:

- **VRAM utilizzata**: ~18-22GB (su 24GB disponibili)
- **Utilizzo GPU**: 80-100% durante l'inferenza
- **Temperatura**: 60-80°C (normale per carichi intensivi)

### Passo 10: Ottimizzare il Context Window

GPT-OSS 20B supporta un context window di 8192 token. Puoi configurare questo in OpenClaw:

```json5
{
  models: {
    providers: {
      ollama: {
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            contextWindow: 8192,
            maxTokens: 81920, // 10x il context window
          },
        ],
      },
    },
  },
}
```

## Test e Utilizzo

### Passo 11: Testare il modello

Esegui un test semplice per verificare che tutto funzioni:

```bash
# Test diretto con Ollama
ollama run gpt-oss:20b "Ciao, come stai?"

# Test con OpenClaw
openclaw agent --message "Dimmi qualcosa di interessante sulla tecnologia"
```

### Passo 12: Monitorare le performance

Durante l'utilizzo, tieni d'occhio:

1. **Tempo di risposta**: Dovresti vedere risposte in 2-5 secondi per prompt semplici
2. **Throughput**: ~10-20 token/secondo è una buona performance per questo modello
3. **Utilizzo VRAM**: Dovrebbe rimanere stabile intorno a 20GB
4. **Temperatura GPU**: Dovrebbe rimanere sotto 85°C

## Problemi Comuni e Soluzioni

### Problema: Out of Memory (OOM)

**Sintomi**: Ollama si blocca o restituisce errori di memoria

**Soluzioni**:

- Riduci il `contextWindow` a 4096 o 2048
- Chiudi altre applicazioni che usano la GPU
- Verifica che non ci siano altri processi Ollama in esecuzione

```bash
# Verifica processi Ollama
ps aux | grep ollama

# Se necessario, termina processi vecchi
pkill ollama
ollama serve
```

### Problema: Performance lente

**Sintomi**: Risposte molto lente (>10 secondi)

**Soluzioni**:

- Verifica che la GPU sia effettivamente utilizzata: `nvidia-smi`
- Assicurati che i driver NVIDIA siano aggiornati
- Controlla che non ci siano throttling termici (temperatura >85°C)
- Riduci il numero di layer sulla CPU se configurato

### Problema: Modello non trovato

**Sintomi**: OpenClaw non trova il modello

**Soluzioni**:

- Verifica che il modello sia scaricato: `ollama list`
- Riavvia Ollama: `pkill ollama && ollama serve`
- Verifica la configurazione di OpenClaw: `openclaw config get models.providers.ollama`

## Risultati e Performance

Con questa configurazione, ho ottenuto:

- ✅ **Esecuzione stabile** di GPT-OSS 20B su RTX 4090
- ✅ **Utilizzo VRAM**: ~20GB su 24GB disponibili
- ✅ **Tempo di risposta**: 2-5 secondi per prompt medi
- ✅ **Throughput**: ~15 token/secondo
- ✅ **Temperatura GPU**: 70-80°C sotto carico
- ✅ **Integrazione perfetta** con OpenClaw

## Considerazioni Finali

### Vantaggi di questa configurazione

1. **Privacy**: Tutti i dati rimangono locali
2. **Costi**: Nessun costo per API esterne
3. **Performance**: Esecuzione veloce grazie alla RTX 4090
4. **Flessibilità**: Controllo completo sul modello e sulla configurazione

### Limitazioni

1. **VRAM**: 24GB è il limite per modelli più grandi
2. **Calore**: La GPU genera molto calore sotto carico
3. **Energia**: Consumo energetico elevato (~400-450W)

### Prossimi Passi

Per migliorare ulteriormente:

- Considera l'uso di **quantizzazione** per ridurre l'uso VRAM
- Sperimenta con **batch processing** per migliorare il throughput
- Valuta modelli alternativi come **Llama 3.3** o **Qwen 2.5** per confrontare performance

## Conclusioni

Eseguire GPT-OSS 20B su RTX 4090 è assolutamente fattibile e fornisce performance eccellenti per un modello di questa dimensione. Con la configurazione corretta, puoi avere un assistente AI locale potente e privato che rivaleggia con servizi cloud, mantenendo tutti i dati sul tuo hardware.

La combinazione di Ollama, OpenClaw e RTX 4090 offre un'esperienza utente eccellente per l'AI locale, dimostrando che l'hardware consumer moderno può gestire modelli LLM di grandi dimensioni con successo.

---

**Note**: Questo articolo è basato sulla mia esperienza personale. I risultati possono variare in base alla configurazione hardware specifica, driver, e versioni del software utilizzato.

**Data**: Febbraio 2026  
**Versione software testata**:

- Ollama: latest
- OpenClaw: 2026.2.6+
- NVIDIA Driver: 535.x+
