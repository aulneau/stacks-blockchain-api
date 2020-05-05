import * as net from 'net';
import { Readable } from 'stream';
import { inspect } from 'util';
import PQueue from 'p-queue';
import { hexToBuffer } from '../helpers';
import { CoreNodeMessage, CoreNodeEventType } from './core-node-message';
import {
  DataStore,
  createDbTxFromCoreMsg,
  DbEventBase,
  DbSmartContractEvent,
  DbStxEvent,
  DbEventTypeId,
  DbFtEvent,
  DbAssetEventTypeId,
  DbNftEvent,
  DbBlock,
  DataStoreUpdateData,
} from '../datastore/common';
import { readMessageFromStream, parseMessageTransactions } from './reader';
import { TransactionPayloadTypeID } from '../p2p/tx';

async function handleClientMessage(clientSocket: Readable, db: DataStore): Promise<void> {
  let msg: CoreNodeMessage;
  try {
    const readResult = await readMessageFromStream(clientSocket);
    if (readResult === undefined) {
      console.info('Empty client message');
      return;
    }
    msg = readResult;
  } catch (error) {
    console.error(`error reading messages from socket: ${error}`);
    console.error(error);
    clientSocket.destroy();
    return;
  }

  const parsedMsg = parseMessageTransactions(msg);

  const dbBlock: DbBlock = {
    canonical: true,
    block_hash: parsedMsg.block_hash,
    index_block_hash: parsedMsg.index_block_hash,
    parent_block_hash: parsedMsg.parent_block_hash,
    parent_microblock: parsedMsg.parent_microblock,
    block_height: parsedMsg.block_height,
    burn_block_time: parsedMsg.burn_block_time,
  };

  const dbData: DataStoreUpdateData = {
    block: dbBlock,
    txs: new Array(parsedMsg.transactions.length),
  };

  for (let i = 0; i < parsedMsg.transactions.length; i++) {
    const tx = parsedMsg.parsed_transactions[i];
    dbData.txs[i] = {
      tx: createDbTxFromCoreMsg(tx),
      stxEvents: [],
      ftEvents: [],
      nftEvents: [],
      contractLogEvents: [],
      smartContracts: [],
    };
    if (tx.raw_tx.payload.typeId === TransactionPayloadTypeID.SmartContract) {
      const contractId = `${tx.sender_address}.${tx.raw_tx.payload.name}`;
      dbData.txs[i].smartContracts.push({
        tx_id: tx.core_tx.txid,
        contract_id: contractId,
        block_height: parsedMsg.block_height,
        source_code: tx.raw_tx.payload.codeBody,
        abi: JSON.stringify(tx.core_tx.contract_abi),
        canonical: true,
      });
    }
  }

  for (const event of parsedMsg.events) {
    const dbTx = dbData.txs.find(entry => entry.tx.tx_id === event.txid);
    if (!dbTx) {
      throw new Error(`Unexpected missing tx during event parsing by tx_id ${event.txid}`);
    }
    // TODO: this is not a real event_index -- the core-node needs to keep track and return in better format.
    const eventIndex =
      dbTx.stxEvents.length +
      dbTx.ftEvents.length +
      dbTx.nftEvents.length +
      dbTx.contractLogEvents.length;

    const dbEvent: DbEventBase = {
      event_index: eventIndex,
      tx_id: event.txid,
      block_height: parsedMsg.block_height,
      canonical: true,
    };

    switch (event.type) {
      case CoreNodeEventType.ContractEvent: {
        const entry: DbSmartContractEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.SmartContractLog,
          contract_identifier: event.contract_event.contract_identifier,
          topic: event.contract_event.topic,
          value: hexToBuffer(event.contract_event.raw_value),
        };
        dbTx.contractLogEvents.push(entry);
        break;
      }
      case CoreNodeEventType.StxTransferEvent: {
        const entry: DbStxEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxAsset,
          asset_event_type_id: DbAssetEventTypeId.Transfer,
          sender: event.stx_transfer_event.sender,
          recipient: event.stx_transfer_event.recipient,
          amount: BigInt(event.stx_transfer_event.amount),
        };
        dbTx.stxEvents.push(entry);
        break;
      }
      case CoreNodeEventType.StxMintEvent: {
        const entry: DbStxEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxAsset,
          asset_event_type_id: DbAssetEventTypeId.Mint,
          recipient: event.stx_mint_event.recipient,
          amount: BigInt(event.stx_mint_event.amount),
        };
        dbTx.stxEvents.push(entry);
        break;
      }
      case CoreNodeEventType.StxBurnEvent: {
        const entry: DbStxEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxAsset,
          asset_event_type_id: DbAssetEventTypeId.Burn,
          sender: event.stx_burn_event.sender,
          amount: BigInt(event.stx_burn_event.amount),
        };
        dbTx.stxEvents.push(entry);
        break;
      }
      case CoreNodeEventType.FtTransferEvent: {
        const entry: DbFtEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.FungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Transfer,
          sender: event.ft_transfer_event.sender,
          recipient: event.ft_transfer_event.recipient,
          asset_identifier: event.ft_transfer_event.asset_identifier,
          amount: BigInt(event.ft_transfer_event.amount),
        };
        dbTx.ftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.FtMintEvent: {
        const entry: DbFtEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.FungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Mint,
          recipient: event.ft_mint_event.recipient,
          asset_identifier: event.ft_mint_event.asset_identifier,
          amount: BigInt(event.ft_mint_event.amount),
        };
        dbTx.ftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.NftTransferEvent: {
        const entry: DbNftEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.NonFungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Transfer,
          recipient: event.nft_transfer_event.recipient,
          sender: event.nft_transfer_event.sender,
          asset_identifier: event.nft_transfer_event.asset_identifier,
          value: hexToBuffer(event.nft_transfer_event.raw_value),
        };
        dbTx.nftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.NftMintEvent: {
        const entry: DbNftEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.NonFungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Mint,
          recipient: event.nft_mint_event.recipient,
          asset_identifier: event.nft_mint_event.asset_identifier,
          value: hexToBuffer(event.nft_mint_event.raw_value),
        };
        dbTx.nftEvents.push(entry);
        break;
      }
      default: {
        throw new Error(`Unexpected CoreNodeEventType: ${inspect(event)}`);
      }
    }
  }

  await db.update(dbData);
}

type MessageHandler = (clientSocket: Readable, db: DataStore) => Promise<void> | void;

function createMessageProcessorQueue(): MessageHandler {
  // Create a promise queue so that only one message is handled at a time.
  const processorQueue = new PQueue({ concurrency: 1 });
  const handleFn = async (clientSocket: Readable, db: DataStore): Promise<void> => {
    await processorQueue.add(() => handleClientMessage(clientSocket, db));
  };
  return handleFn;
}

export async function startEventSocketServer(
  db: DataStore,
  messageHandler: MessageHandler = createMessageProcessorQueue()
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(clientSocket => {
      Promise.resolve(messageHandler(clientSocket, db)).catch(error => {
        console.error(`error processing socket connection: ${error}`);
        console.error(error);
      });
      clientSocket.on('end', () => {
        // do nothing for now
      });
    });
    server.on('error', error => {
      console.error(`socket server error: ${error}`);
      reject(error);
    });
    const socketHost = process.env['STACKS_SIDECAR_SOCKET_HOST'];
    const socketPort = Number.parseInt(process.env['STACKS_SIDECAR_SOCKET_PORT'] ?? '', 10);
    if (!socketHost) {
      throw new Error(
        `STACKS_SIDECAR_SOCKET_HOST must be specified, e.g. "STACKS_SIDECAR_SOCKET_HOST=127.0.0.1"`
      );
    }
    if (!socketPort) {
      throw new Error(
        `STACKS_SIDECAR_SOCKET_PORT must be specified, e.g. "STACKS_SIDECAR_SOCKET_PORT=3700"`
      );
    }
    server.listen(socketPort, socketHost, () => {
      const addr = server.address();
      if (addr === null) {
        throw new Error('server missing address');
      }
      const addrStr = typeof addr === 'string' ? addr : `${addr.address}:${addr.port}`;
      console.log(`core node event server listening at ${addrStr}`);
      resolve(server);
    });
  });
}