/*
Copyright 2016, 2019, 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { uniq } from "lodash";
import { Room } from "matrix-js-sdk/src/models/room";
import { ClientEvent, MatrixClient } from "matrix-js-sdk/src/client";
import { logger } from "matrix-js-sdk/src/logger";
import { EventType } from "matrix-js-sdk/src/@types/event";
import { MatrixEvent } from "matrix-js-sdk/src/models/event";
import { Optional } from "matrix-events-sdk";

import { MatrixClientPeg } from "../MatrixClientPeg";

/**
 * Class that takes a Matrix Client and flips the m.direct map
 * so the operation of mapping a room ID to which user it's a DM
 * with can be performed efficiently.
 *
 * With 'start', this can also keep itself up to date over time.
 */
export default class DMRoomMap {
    private static sharedInstance: DMRoomMap;

    // TODO: convert these to maps
    private roomToUser: { [key: string]: string } | null = null;
    private userToRooms: { [key: string]: string[] } | null = null;
    private hasSentOutPatchDirectAccountDataPatch: boolean;
    private mDirectEvent: { [key: string]: string[] };

    public constructor(private readonly matrixClient: MatrixClient) {
        // see onAccountData
        this.hasSentOutPatchDirectAccountDataPatch = false;

        const mDirectEvent = matrixClient.getAccountData(EventType.Direct)?.getContent() ?? {};
        this.mDirectEvent = { ...mDirectEvent }; // copy as we will mutate
    }

    /**
     * Makes and returns a new shared instance that can then be accessed
     * with shared(). This returned instance is not automatically started.
     */
    public static makeShared(): DMRoomMap {
        DMRoomMap.sharedInstance = new DMRoomMap(MatrixClientPeg.get());
        return DMRoomMap.sharedInstance;
    }

    /**
     * Set the shared instance to the instance supplied
     * Used by tests
     * @param inst the new shared instance
     */
    public static setShared(inst: DMRoomMap): void {
        DMRoomMap.sharedInstance = inst;
    }

    /**
     * Returns a shared instance of the class
     * that uses the singleton matrix client
     * The shared instance must be started before use.
     */
    public static shared(): DMRoomMap {
        return DMRoomMap.sharedInstance;
    }

    public start(): void {
        this.populateRoomToUser();
        this.matrixClient.on(ClientEvent.AccountData, this.onAccountData);
    }

    public stop(): void {
        this.matrixClient.removeListener(ClientEvent.AccountData, this.onAccountData);
    }

    private onAccountData = (ev: MatrixEvent): void => {
        if (ev.getType() == EventType.Direct) {
            this.mDirectEvent = { ...ev.getContent() }; // copy as we will mutate
            this.userToRooms = null;
            this.roomToUser = null;
        }
    };

    /**
     * some client bug somewhere is causing some DMs to be marked
     * with ourself, not the other user. Fix it by guessing the other user and
     * modifying userToRooms
     */
    private patchUpSelfDMs(userToRooms: Record<string, string[]>): boolean {
        const myUserId = this.matrixClient.getUserId()!;
        const selfRoomIds = userToRooms[myUserId];
        if (selfRoomIds) {
            // any self-chats that should not be self-chats?
            const guessedUserIdsThatChanged = selfRoomIds
                .map((roomId) => {
                    const room = this.matrixClient.getRoom(roomId);
                    if (room) {
                        const userId = room.guessDMUserId();
                        if (userId && userId !== myUserId) {
                            return { userId, roomId };
                        }
                    }
                })
                .filter((ids) => !!ids) as { userId: string; roomId: string }[]; //filter out
            // these are actually all legit self-chats
            // bail out
            if (!guessedUserIdsThatChanged.length) {
                return false;
            }
            userToRooms[myUserId] = selfRoomIds.filter((roomId) => {
                return !guessedUserIdsThatChanged.some((ids) => ids.roomId === roomId);
            });
            guessedUserIdsThatChanged.forEach(({ userId, roomId }) => {
                const roomIds = userToRooms[userId];
                if (!roomIds) {
                    userToRooms[userId] = [roomId];
                } else {
                    roomIds.push(roomId);
                    userToRooms[userId] = uniq(roomIds);
                }
            });
            return true;
        }
        return false;
    }

    public getDMRoomsForUserId(userId: string): string[] {
        // Here, we return the empty list if there are no rooms,
        // since the number of conversations you have with this user is zero.
        return this.getUserToRooms()[userId] || [];
    }

    /**
     * Gets the DM room which the given IDs share, if any.
     * @param {string[]} ids The identifiers (user IDs and email addresses) to look for.
     * @returns {Room} The DM room which all IDs given share, or falsy if no common room.
     */
    public getDMRoomForIdentifiers(ids: string[]): Room | null {
        // TODO: [Canonical DMs] Handle lookups for email addresses.
        // For now we'll pretend we only get user IDs and end up returning nothing for email addresses

        let commonRooms = this.getDMRoomsForUserId(ids[0]);
        for (let i = 1; i < ids.length; i++) {
            const userRooms = this.getDMRoomsForUserId(ids[i]);
            commonRooms = commonRooms.filter((r) => userRooms.includes(r));
        }

        const joinedRooms = commonRooms
            .map((r) => MatrixClientPeg.get().getRoom(r))
            .filter((r) => r && r.getMyMembership() === "join");

        return joinedRooms[0];
    }

    public getUserIdForRoomId(roomId: string): Optional<string> {
        if (this.roomToUser == null) {
            // we lazily populate roomToUser so you can use
            // this class just to call getDMRoomsForUserId
            // which doesn't do very much, but is a fairly
            // convenient wrapper and there's no point
            // iterating through the map if getUserIdForRoomId()
            // is never called.
            this.populateRoomToUser();
        }
        // Here, we return undefined if the room is not in the map:
        // the room ID you gave is not a DM room for any user.
        if (this.roomToUser![roomId] === undefined) {
            // no entry? if the room is an invite, look for the is_direct hint.
            const room = this.matrixClient.getRoom(roomId);
            if (room) {
                return room.getDMInviter();
            }
        }
        return this.roomToUser![roomId];
    }

    public getUniqueRoomsWithIndividuals(): { [userId: string]: Room } {
        if (!this.roomToUser) return {}; // No rooms means no map.
        return Object.keys(this.roomToUser)
            .map((r) => ({ userId: this.getUserIdForRoomId(r), room: this.matrixClient.getRoom(r) }))
            .filter((r) => r.userId && r.room && r.room.getInvitedAndJoinedMemberCount() === 2)
            .reduce((obj, r) => (obj[r.userId] = r.room) && obj, {} as Record<string, Room>);
    }

    /**
     * @returns all room Ids from m.direct
     */
    public getRoomIds(): Set<string> {
        return Object.values(this.mDirectEvent).reduce((prevRoomIds: Set<string>, roomIds: string[]): Set<string> => {
            roomIds.forEach((roomId) => prevRoomIds.add(roomId));
            return prevRoomIds;
        }, new Set<string>());
    }

    private getUserToRooms(): { [key: string]: string[] } {
        if (!this.userToRooms) {
            const userToRooms = this.mDirectEvent;
            const myUserId = this.matrixClient.getUserId()!;
            const selfDMs = userToRooms[myUserId];
            if (selfDMs?.length) {
                const neededPatching = this.patchUpSelfDMs(userToRooms);
                // to avoid multiple devices fighting to correct
                // the account data, only try to send the corrected
                // version once.
                logger.warn(
                    `Invalid m.direct account data detected ` + `(self-chats that shouldn't be), patching it up.`,
                );
                if (neededPatching && !this.hasSentOutPatchDirectAccountDataPatch) {
                    this.hasSentOutPatchDirectAccountDataPatch = true;
                    this.matrixClient.setAccountData(EventType.Direct, userToRooms);
                }
            }
            this.userToRooms = userToRooms;
        }
        return this.userToRooms;
    }

    private populateRoomToUser(): void {
        this.roomToUser = {};
        for (const user of Object.keys(this.getUserToRooms())) {
            for (const roomId of this.userToRooms![user]) {
                this.roomToUser[roomId] = user;
            }
        }
    }
}
