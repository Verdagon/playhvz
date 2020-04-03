/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

import * as Chat from './data/chat';
import * as ChatUtils from './utils/chatutils';
import * as Defaults from './data/defaults';
import * as Game from './data/game';
import * as Group from './data/group';
import * as Player from './data/player';
import * as PlayerUtils from './utils/playerutils';
import * as Message from './data/message';
import * as Mission from './data/mission';
import * as User from './data/user';

admin.initializeApp();
const db = admin.firestore();

/*******************************************************
* USER functions
********************************************************/

exports.registerDevice = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
   }

  const deviceToken = data.deviceToken;
  if (!(typeof deviceToken === 'string') || deviceToken.length === 0) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
          'one argument "deviceToken" containing the deviceToken to set.');
    }

  const updatedData = {'deviceToken': deviceToken};
  return await db.collection(User.COLLECTION_PATH).doc(context.auth.uid).set(updatedData);
});



/*******************************************************
* GAME functions
********************************************************/

exports.createGame = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }

  const name = trimmedString(data.name);
  if (name.length === 0) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
          'one argument "name" containing the game name to create.');
   }

  const gameQuery = await db.collection(Game.COLLECTION_PATH).where(Game.FIELD__NAME, "==", name).get();
  if (!gameQuery.empty) {
    throw new functions.https.HttpsError('already-exists', 'A game with the given name already exists');
  }

  const gameData = {
    "name": name,
    "creatorUserId": context.auth.uid,
  }

  const gameId = (await db.collection(Game.COLLECTION_PATH).add(gameData)).id;
  await createGlobalGroup(context.auth.uid, gameId);
  return gameId;
});


exports.checkGameExists = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }

  let name = data.name;
  if (!(typeof name === 'string')) {
      throw new functions.https.HttpsError('invalid-argument', "Expected value to be type String.");
  }
  name = trimmedString(name);
  if (name.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
          'one argument "name" containing the game name to create.');
   }

  const querySnapshot = await db.collection(Game.COLLECTION_PATH).where(Game.FIELD__NAME, "==", name).get();
  if (querySnapshot.empty || querySnapshot.docs.length > 1) {
    throw new functions.https.HttpsError('failed-precondition', 'No game with given name exists.');
  }
});


exports.joinGame = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }
  const uid = context.auth.uid;
  let gameName = data.gameName;
  let playerName = data.playerName;
  if (!(typeof gameName === 'string') || !(typeof playerName === 'string')) {
      throw new functions.https.HttpsError('invalid-argument', "Expected value to be type String.");
  }
  gameName = trimmedString(gameName);
  playerName = trimmedString(playerName);
  if (gameName.length === 0 || playerName.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
          'one argument "gameName" containing the game name to create and "playerName".');
  }

  const gameQuerySnapshot = await db.collection(Game.COLLECTION_PATH).where(Game.FIELD__NAME, "==", gameName).get();
  if (gameQuerySnapshot.empty || gameQuerySnapshot.docs.length > 1) {
     throw new functions.https.HttpsError('failed-precondition', 'No game with given name exists.');
  }
  const game = gameQuerySnapshot.docs[0];
  const gameId = game.id;
  const userPlayerQuerySnapshot = await PlayerUtils.getUsersPlayersQuery(db, uid, gameId).get();
  if (!userPlayerQuerySnapshot.empty) {
    throw new functions.https.HttpsError('failed-precondition', 'User is already a player in this game.');
  }

  const playerNameQuerySnapshot = await PlayerUtils.getPlayersWithNameQuery(db, gameId, playerName).get();
  if (!playerNameQuerySnapshot.empty) {
      throw new functions.https.HttpsError('failed-precondition', 'Player name already taken.');
  }

  const player = Player.create(uid, playerName);
  const playerDocument = (await db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Player.COLLECTION_PATH)
    .add(player));

  await addNewPlayerToGroups(gameId, playerDocument)
  return gameId
});


/**
 * Initiate a recursive delete of documents at a given path.
 *
 * The calling user must be authenticated and have the custom "admin" attribute
 * set to true on the auth token.
 *
 * This delete is NOT an atomic operation and it's possible
 * that it may fail after only deleting some documents.
 *
 * @param {string} data.path the document or collection path to delete.
 */
exports.deleteGame = functions.runWith({
    timeoutSeconds: 540,
    memory: '2GB'
}).https.onCall(async (data, context) => {
    // Only allow admin users to execute this function.
    if (!(context.auth)) {
    /* TODO: only allow for admins once we launch game (&& context.auth.token && context.auth.token.admin) */
      throw new functions.https.HttpsError('permission-denied', 'Must be an administrative user to initiate delete.');
    }

    const gameId = data.gameId;
    console.log(
      `User ${context.auth.uid} has requested to delete game ${gameId}`
    );

    // Run a recursive delete on the game document path.
    const gameRef = db.collection(Game.COLLECTION_PATH).doc(gameId);
    await gameRef.listCollections().then(async (collections: any) => {
      for (const collection of collections) {
        await deleteCollection(collection)
      }
      await gameRef.delete()
    });
});

/*******************************************************
* PLAYER functions
********************************************************/

exports.changePlayerAllegiance = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }
  const gameId = data.gameId;
  const playerId = data.playerId;
  const newAllegiance = data.allegiance;
  if (!(typeof gameId === 'string') || !(typeof playerId === 'string') || !(typeof newAllegiance === 'string')) {
      throw new functions.https.HttpsError('invalid-argument', "Expected value to be type String.");
  }
  if (gameId.length === 0 || playerId.length === 0 || newAllegiance.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
          'a valid gameId, playerId, and allegiance.');
  }

  const player = await db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Player.COLLECTION_PATH)
    .doc(playerId)
    .get()
  const playerData = player.data()
  if (playerData === undefined) {
    console.log("Player data is undefined, not updating allegiance")
    return
  }
  if (playerData[Player.FIELD__ALLEGIANCE] === newAllegiance) {
    console.log("Not changing allegiance, it's already set to " + newAllegiance)
    return
  }

  // Update player allegiance
  await player.ref.update({
    [Player.FIELD__ALLEGIANCE]: newAllegiance
  })

  // Update chat room memberships
  for (const chatRoomId in playerData[Player.FIELD__CHAT_MEMBERSHIPS]) {
    const chatRoom = (await db.collection(Game.COLLECTION_PATH)
       .doc(gameId)
       .collection(Chat.COLLECTION_PATH)
       .doc(chatRoomId)
       .get())
       .data();
    if (chatRoom === undefined) {
      continue
    }
    const group = await db.collection(Game.COLLECTION_PATH)
        .doc(gameId)
        .collection(Group.COLLECTION_PATH)
        .doc(chatRoom[Chat.FIELD__GROUP_ID])
        .get()
    const groupData = group.data()
    if (groupData === undefined) {
      continue
    }
    if (groupData[Group.FIELD__SETTINGS][Group.FIELD__SETTINGS_AUTO_REMOVE] === true) {
      if (groupData[Group.FIELD__SETTINGS][Group.FIELD__SETTINGS_ALLEGIANCE_FILTER] !== newAllegiance) {
        await ChatUtils.removePlayerFromChat(db, gameId, player, group, chatRoomId)
      }
    }
  }
});


/*******************************************************
* GROUP functions
********************************************************/

// Creates a group
async function createGlobalGroup(uid: any, gameId: string) {
  const group = Group.createManagedGroup(
    /* name= */ Defaults.globalChatName,
    /* settings= */ Group.getGlobalGroupSettings(),
  )
  const createdGroup = await db.collection(Game.COLLECTION_PATH).doc(gameId).collection(Group.COLLECTION_PATH).add(group);
  const chat = Chat.create(createdGroup.id, Defaults.globalChatName)
  await db.collection(Game.COLLECTION_PATH).doc(gameId).collection(Chat.COLLECTION_PATH).add(chat)
}

// Add player to global chatroom
async function addNewPlayerToGroups(gameId: string, player: any) {
  const groupQuery = await db.collection(Game.COLLECTION_PATH).doc(gameId).collection(Group.COLLECTION_PATH)
  .where(Group.FIELD__MANAGED, "==", true)
  .where(Group.FIELD__NAME, "==", Defaults.globalChatName).get()

  if (groupQuery.empty || groupQuery.docs.length > 1) {
    throw new functions.https.HttpsError('failed-precondition', 'Cannot find global chat.');
  }
  const group = groupQuery.docs[0];
  const chatQuery = await db.collection(Game.COLLECTION_PATH).doc(gameId).collection(Chat.COLLECTION_PATH)
    .where(Chat.FIELD__GROUP_ID, "==", group.id).get()
  if (chatQuery.empty || chatQuery.docs.length > 1) {
    throw new functions.https.HttpsError('failed-precondition', 'Cannot find chatroom associated with group.');
  }

  await group.ref.update({
      [Group.FIELD__MEMBERS]: admin.firestore.FieldValue.arrayUnion(player.id)
  });

  const chatId = chatQuery.docs[0].id;
  const chatVisibility = {[Player.FIELD__CHAT_VISIBILITY]: true}
  // We have to use dot-notation or firebase will overwrite the entire field.
  const membershipField = Player.FIELD__CHAT_MEMBERSHIPS + "." + chatId
  await player.update({
    [membershipField]: chatVisibility
  })
}

exports.addPlayersToChat = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }

  const gameId = data.gameId;
  const groupId = data.groupId;
  const chatRoomId = data.chatRoomId;
  const playerIdList = data.playerIdList
  if (!(typeof gameId === 'string') || !(typeof groupId === 'string') || !(typeof chatRoomId === 'string')) {
      throw new functions.https.HttpsError('invalid-argument', "Expected value to be type String.");
  }
  if (gameId.length === 0 || groupId.length === 0 || chatRoomId.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
          'a valid gameId and groupId and chatRoomId.');
  }

  const group = await db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Group.COLLECTION_PATH)
    .doc(groupId)
    .get();

  for (const playerId of playerIdList) {
    await ChatUtils.addPlayerToChat(db, gameId, playerId, group, chatRoomId, /* isNewGroup= */ false)
  }
});

// Creates a group
async function createGroupAndChat(uid: any, gameId: string, playerId: string, chatName: string, settings: any) {
  const group = Group.createPlayerOwnedGroup(
    playerId,
    chatName,
    /* settings= */ settings,
  )
  const createdGroup = await db.collection(Game.COLLECTION_PATH).doc(gameId).collection(Group.COLLECTION_PATH).add(group);
  const chat = Chat.create(createdGroup.id, chatName)
  const createdChat = await db.collection(Game.COLLECTION_PATH).doc(gameId).collection(Chat.COLLECTION_PATH).add(chat)
  await ChatUtils.addPlayerToChat(db, gameId, playerId, createdGroup, createdChat.id, /* isNewGroup= */ true)
}

// Creates a group and mission
async function createGroupAndMission(
  gameId: string,
  settings: any,
  missionName: string,
  startTime: number,
  endTime: number,
  details: string,
  allegianceFilter: string
) {
  const group = Group.createManagedGroup(missionName, settings)
  const createdGroup = await db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Group.COLLECTION_PATH)
    .add(group);
  const mission = Mission.create(
    createdGroup.id,
    missionName,
    startTime,
    endTime,
    details,
    allegianceFilter
  )
  await db.collection(Game.COLLECTION_PATH).doc(gameId).collection(Mission.COLLECTION_PATH).add(mission)
  await updateGroupMembership(gameId, createdGroup.id)
}

// Handles Auto-adding and Auto-removing members
async function updateGroupMembership(gameId: string, groupId: string) {
  const group = await db.collection(Game.COLLECTION_PATH)
          .doc(gameId)
          .collection(Group.COLLECTION_PATH)
          .doc(groupId)
          .get()
  await autoAddMembers(gameId, group)
}

// Adds members if appropriate
async function autoAddMembers(gameId: string, group: any) {
  const groupData = group.data()
  if (groupData === undefined) {
    return
  }
  if (groupData[Group.FIELD__MANAGED] !== true
      && groupData[Group.FIELD__SETTINGS][Group.FIELD__SETTINGS_AUTO_ADD] !== true) {
    return
  }

  let playerQuerySnapshot = null
  if (groupData[Group.FIELD__SETTINGS][Group.FIELD__SETTINGS_ALLEGIANCE_FILTER] === Defaults.EMPTY_ALLEGIANCE_FILTER) {
    // Add all players to the group
    playerQuerySnapshot = await db.collection(Game.COLLECTION_PATH)
      .doc(gameId)
      .collection(Player.COLLECTION_PATH)
      .get()
  } else {
    // Add all players of the correct allegiance to the group
    playerQuerySnapshot = await db.collection(Game.COLLECTION_PATH)
      .doc(gameId)
      .collection(Player.COLLECTION_PATH)
      .where(Player.FIELD__ALLEGIANCE, "==", groupData[Group.FIELD__SETTINGS][Group.FIELD__SETTINGS_ALLEGIANCE_FILTER])
      .get()
  }

  if (playerQuerySnapshot === null) {
    return
  }
  const playerIdArray = new Array();
  playerQuerySnapshot.forEach(playerDoc => {
    playerIdArray.push(playerDoc.id)
  });
  if (playerIdArray.length > 0) {
    await group.ref.update({
        [Group.FIELD__MEMBERS]: playerIdArray
      })
  }
}


exports.removePlayerFromChat = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }

  const gameId = data.gameId;
  const playerId = data.playerId;
  const chatRoomId = data.chatRoomId;
  if (!(typeof gameId === 'string') || !(typeof playerId === 'string') || !(typeof chatRoomId === 'string')) {
      throw new functions.https.HttpsError('invalid-argument', "Expected value to be type String.");
  }
  if (gameId.length === 0 || playerId.length === 0 || chatRoomId.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
          'a valid gameId, playerId, and chatRoomId.');
  }

  const player = await db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Player.COLLECTION_PATH)
    .doc(playerId)
    .get()

  const chatRoom = (await db.collection(Game.COLLECTION_PATH)
     .doc(gameId)
     .collection(Chat.COLLECTION_PATH)
     .doc(chatRoomId)
     .get())
     .data();
  if (chatRoom === undefined) {
    console.log("Chat room was undefined, not removing player.")
    return
  }

  const group = await db.collection(Game.COLLECTION_PATH)
      .doc(gameId)
      .collection(Group.COLLECTION_PATH)
      .doc(chatRoom[Chat.FIELD__GROUP_ID])
      .get()

  await ChatUtils.removePlayerFromChat(db, gameId, player, group, chatRoomId)
});

/*******************************************************
* CHAT functions
********************************************************/

// Sends a chat message
// TODO: make this happen as a single transaction
exports.sendChatMessage = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }
  const gameId = data.gameId;
  const chatRoomId = data.chatRoomId;
  const senderId = data.senderId;
  const message = data.message;
  if (!(typeof gameId === 'string')
        || !(typeof chatRoomId === 'string')
        || !(typeof senderId === 'string')
        || !(typeof message === 'string')) {
    throw new functions.https.HttpsError('invalid-argument', "Expected value to be type String and not empty.");
  }
  if (gameId.length === 0 || chatRoomId.length === 0 || senderId.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
            '4 arguments.');
  }
  if (message.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'Message was empty, not sending it.');
  }

  // Make sure player is still a member of chat room
  const chatRoom = await db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Chat.COLLECTION_PATH)
    .doc(chatRoomId)
    .get()
  const group = await db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Group.COLLECTION_PATH)
    .doc(chatRoom.get(Chat.FIELD__GROUP_ID))
    .get()
  if (group.get(Group.FIELD__MEMBERS).indexOf(senderId) < 0) {
    throw new functions.https.HttpsError('failed-precondition', 'Player is not a member of chat.');
  }

  const messageDocument = Message.create(
    senderId,
    getTimestamp(),
    message
  );
  await db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Chat.COLLECTION_PATH)
    .doc(chatRoomId)
    .collection(Message.COLLECTION_PATH)
    .add(messageDocument)
})

// Creates a chat room
// TODO: make this happen as a single transaction
exports.createChatRoom = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }
  const gameId = data.gameId;
  const ownerId = data.ownerId;
  const chatName = data.chatName;
  const allegianceFilter = data.allegianceFilter

  if (!(typeof gameId === 'string')
        || !(typeof ownerId === 'string')
        || !(typeof chatName === 'string')
        || !(typeof allegianceFilter === 'string')) {
    throw new functions.https.HttpsError('invalid-argument', "Expected value to be type String and not empty.");
  }
  if (gameId.length === 0 || ownerId.length === 0 || chatName.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
            '4 arguments.');
  }
  if (allegianceFilter.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'AllegianceFilter was empty, should be ${Defaults.EMPTY_ALLEGIANCE_FILTER} or race.');
  }

  const settings = Group.createSettings(
    /* addSelf= */ true,
    /* addOthers= */ true,
    /* removeSelf= */ true,
    /* removeOthers= */ false,
    /* autoAdd= */ false,
    /* autoRemove= */ allegianceFilter !== Defaults.EMPTY_ALLEGIANCE_FILTER,
    allegianceFilter);

    await createGroupAndChat(context.auth.uid, gameId, ownerId, chatName, settings);
})

/*******************************************************
* MISSION functions
********************************************************/

exports.createMission = functions.https.onCall(async (data, context) => {
if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }
  const gameId = data.gameId;
  const missionName = data.name;
  const startTime = data.startTime;
  const endTime = data.endTime;
  const details = data.details;
  const allegianceFilter = data.allegianceFilter

  if (!(typeof gameId === 'string')
        || !(typeof missionName === 'string')
        || !(typeof details === 'string')
        || !(typeof allegianceFilter === 'string')) {
    throw new functions.https.HttpsError('invalid-argument', "Expected value to be type String.");
  }

  if (!(typeof startTime === 'number') || !(typeof endTime === 'number')) {
      throw new functions.https.HttpsError('invalid-argument', "Expected value to be type number.");
  }

  if (gameId.length === 0 || missionName.length === 0 || allegianceFilter.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
            'valid string arguments.');
  }

  const settings = Group.createSettings(
    /* addSelf= */ false,
    /* addOthers= */ false,
    /* removeSelf= */ false,
    /* removeOthers= */ false,
    /* autoAdd= */ true,
    /* autoRemove= */ allegianceFilter !== Defaults.EMPTY_ALLEGIANCE_FILTER,
    allegianceFilter);

    await createGroupAndMission(
      gameId,
      settings,
      missionName,
      startTime,
      endTime,
      details,
      allegianceFilter
    )
})

// TODO: run this as a transaction
exports.updateMission = functions.https.onCall(async (data, context) => {
if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }
  const gameId = data.gameId;
  const missionId = data.missionId;
  const missionName = data.name;
  const startTime = data.startTime;
  const endTime = data.endTime;
  const details = data.details;
  const allegianceFilter = data.allegianceFilter

  if (!(typeof gameId === 'string')
        || !(typeof missionId === 'string')
        || !(typeof missionName === 'string')
        || !(typeof details === 'string')
        || !(typeof allegianceFilter === 'string')) {
    throw new functions.https.HttpsError('invalid-argument', "Expected value to be type String.");
  }

  if (!(typeof startTime === 'number') || !(typeof endTime === 'number')) {
      throw new functions.https.HttpsError('invalid-argument', "Expected value to be type number.");
  }

  if (gameId.length === 0
      || missionId.length === 0
      || missionName.length === 0
      || allegianceFilter.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
            'valid string arguments.');
  }

  const missionRef = db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Mission.COLLECTION_PATH)
    .doc(missionId)

  const missionData = (await missionRef.get()).data()
  if (missionData === undefined) {
    return
  }
  const associatedGroupId = missionData[Mission.FIELD__GROUP_ID]

  await missionRef.update({
    [Mission.FIELD__NAME]: missionName,
    [Mission.FIELD__START_TIME]: startTime,
    [Mission.FIELD__END_TIME]: endTime,
    [Mission.FIELD__DETAILS]: details,
    [Mission.FIELD__ALLEGIANCE_FILTER]: allegianceFilter
  });

  const groupRef = db.collection(Game.COLLECTION_PATH)
      .doc(gameId)
      .collection(Group.COLLECTION_PATH)
      .doc(associatedGroupId);
  // We have to use dot-notation or firebase will overwrite the entire field.
  const allegianceField = Group.FIELD__SETTINGS + "." + Group.FIELD__SETTINGS_ALLEGIANCE_FILTER
  await groupRef.update({
    [Group.FIELD__NAME]: missionName,
    [allegianceField]: allegianceFilter
  })
  await updateGroupMembership(gameId, associatedGroupId)
})

exports.deleteMission = functions.https.onCall(async (data, context) => {
if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError('unauthenticated', 'The function must be called ' +
          'while authenticated.');
  }
  const gameId = data.gameId;
  const missionId = data.missionId;

  if (!(typeof gameId === 'string') || !(typeof missionId === 'string')) {
    throw new functions.https.HttpsError('invalid-argument', "Expected value to be type String.");
  }

  if (gameId.length === 0 || missionId.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with ' +
            'valid id arguments.');
  }

  // Delete the mission document recursively
  const missionRef = db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Mission.COLLECTION_PATH)
    .doc(missionId);
  const missionData = (await missionRef.get()).data()
  if (missionData === undefined) {
    return
  }
  const associatedGroupId = missionData[Mission.FIELD__GROUP_ID]
  await missionRef.listCollections().then(async (collections: any) => {
    for (const collection of collections) {
      await deleteCollection(collection)
    }
    await missionRef.delete()
  });

  // Delete the associated group document recursively
  console.log(`Deleting associated group id: ${associatedGroupId}`)
  const groupRef = db.collection(Game.COLLECTION_PATH)
    .doc(gameId)
    .collection(Group.COLLECTION_PATH)
    .doc(associatedGroupId);
  await groupRef.listCollections().then(async (collections: any) => {
    for (const collection of collections) {
      await deleteCollection(collection)
    }
    await groupRef.delete()
  });
})

/*******************************************************
* Util functions
********************************************************/

function trimmedString(rawText: any): string {
  return rawText.trim();
}

function getTimestamp(): any {
  return admin.firestore.Timestamp.now()
}

async function deleteCollection(collection: any) {
  const collectionRef = db.collection(collection.path)
  await collectionRef.listDocuments().then((docRefs: any) => {
    return db.getAll(...docRefs)
  }).then(async (documentSnapshots: any) => {
    for (const documentSnapshot of documentSnapshots) {
       if (documentSnapshot.exists) {
          console.log(`Found document with data: ${documentSnapshot.id}`);
       } else {
          console.log(`Found missing document: ${documentSnapshot.id}`);
       }
       await deleteDocument(documentSnapshot.ref)
    }
  })
}

async function deleteDocument(documentRef: any) {
  await documentRef.listCollections().then(async (collections: any) => {
        for (const collection of collections) {
          console.log(`Found subcollection with id: ${collection.id}`);
          await deleteCollection(collection)
        }
        // Done deleting all children, can delete this doc now.
        await documentRef.delete()
  })
}







