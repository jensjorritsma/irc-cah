var util = require('util'),
    c = require('irc-colors'),
    _ = require('underscore'),
    Cards = require('../controllers/cards'),
    Card = require('../models/card');

/**
 * Available states for game
 * @type {{STOPPED: string, STARTED: string, PLAYABLE: string, PLAYED: string, ROUND_END: string, WAITING: string}}
 */
var STATES = {
    STOPPED:   'Stopped',
    STARTED:   'Started',
    PLAYABLE:  'Playable',
    PLAYED:    'Played',
    ROUND_END: 'RoundEnd',
    WAITING:   'Waiting',
    PAUSED:    'Paused'
};

// TODO: Implement the ceremonial haiku round that ends the game
var HAIKU = new Card({
    "draw": 2,
    "pick": 3,
    "text": "(Draw 2, Pick 3) Make a haiku."
});

var Game = function Game(channel, client, config) {
    var self = this;

    // properties
    self.waitCount = 0; // number of times waited until enough players
    self.round = 0; // round number
    self.players = []; // list of players
    self.channel = channel; // the channel this game is running on
    self.client = client; // reference to the irc client
    self.config = config; // configuration data
    self.state = STATES.STARTED; // game state storage
    self.pauseState = []; // pause state storage
    self.points = [];

    console.log('whites', config.cards.whites);

    // init decks
    self.decks = {
        white: new Cards(config.cards.whites),
        black: new Cards(config.cards.blacks)
    };
    // init discard piles
    self.discards = {
        white: new Cards(),
        black: new Cards()
    };
    // init table slots
    self.table = {
        white: null,
        black: []
    };
    // shuffle decks
    self.decks.white.shuffle();
    self.decks.black.shuffle();

    /**
     * Stop game
     */
    self.stop = function (player) {
        self.state = STATES.STOPPED;

        if (typeof player !== 'undefined') {
            self.say(player.nick + ' stopped the game.');
        } else {
            self.say('Game has been stopped.');
        }
        self.showPoints();

        // clear all timers
        clearTimeout(self.startTimeout);
        clearTimeout(self.stopTimeout);
        clearTimeout(self.turnTimer);
        clearTimeout(self.winnerTimer);

        // Destroy cards & players
        delete self.players;
        delete self.config;
        delete self.client;
        delete self.channel;
        delete self.round;
        delete self.decks;
        delete self.discards;
        delete self.table;
    };

    /**
     * Pause game
     */
    self.pause = function () {
        // check if game is already paused
        if (self.state === STATES.PAUSED) {
            self.say('Game is already paused. Type !resume to begin playing again.');
            return false;
        }
        
        // only allow pause if game is in PLAYABLE or PLAYED state
        if (self.state !== STATES.PLAYABLE && self.state !== STATES.PLAYED) {
            self.say('The game cannot be paused right now.');
            return false;
        }
        
        // store state and pause game
        var now = new Date();
        self.pauseState.state = self.state;
        self.pauseState.elapsed = now.getTime() - self.roundStarted.getTime();
        self.state = STATES.PAUSED;

        self.say('Game is now paused. Type !resume to begin playing again.');

        // clear turn timers
        clearTimeout(self.turnTimer);
        clearTimeout(self.winnerTimer);
    };
    
    /**
     * Resume game
     */
    self.resume = function () {
        // make sure game is paused
        if (self.state !== STATES.PAUSED) {
            self.say('The game is not paused.');
            return false;
        }
        
        // resume game
        var now = new Date();
        var newTime = new Date();
        newTime.setTime(now.getTime() - self.pauseState.elapsed);
        self.roundStarted = newTime;
        self.state = self.pauseState.state;

        self.say('Game has been resumed.');

        // resume timers
        if (self.state === STATES.PLAYED) {
            self.winnerTimer = setInterval(self.winnerTimerCheck, 10 * 1000);
        } else if (self.state === STATES.PLAYABLE) {
            self.turnTimer = setInterval(self.turnTimerCheck, 10 * 1000);
        }
    };

    /**
     * Start next round
     */
    self.nextRound = function () {
        clearTimeout(self.stopTimeout);
        if (self.players.length < 3) {
            self.say('Not enough players to start a round (need at least 3). Waiting for others to join. Stopping in 3 minutes if not enough players.');
            self.state = STATES.WAITING;
            // stop game if not enough pleyers in 3 minutes
            self.stopTimeout = setTimeout(self.stop, 3 * 60 * 1000);
            return false;
        }
        self.round++;
        console.log('Starting round ', self.round);
        self.setCzar();
        self.deal();
        self.say('Round ' + self.round + '! ' + self.czar.nick + ' is the card czar.');
        self.playWhite();
        // show cards for all players (except czar)
        _.each(self.players, function (player) {
            if (player.isCzar !== true) {
                self.showCards(player);
            }
        });
        self.state = STATES.PLAYABLE;
    };

    /**
     * Set a new czar
     * @returns Player The player object who is the new czar
     */
    self.setCzar = function () {
        if (self.czar) {
            console.log('Old czar:', self.czar.nick);
        }
        self.czar = self.players[self.players.indexOf(self.czar) + 1] || self.players[0];
        console.log('New czar:', self.czar.nick);
        self.czar.isCzar = true;
        return self.czar;
    };

    /**
     * Deal cards to fill players' hands
     */
    self.deal = function () {
        _.each(self.players, function (player) {
            console.log(player.nick + '(' + player.hostname + ') has ' + player.cards.numCards() + ' cards. Dealing ' + (10 - player.cards.numCards()) + ' cards');
            for (var i = player.cards.numCards(); i < 10; i++) {
                self.checkDecks();
                var card = self.decks.black.pickCards();
                player.cards.addCard(card);
                card.owner = player;
            }
        }, this);
    };

    /**
     * Clean up table after round is complete
     */
    self.clean = function () {
        // move cards from table to discard
        self.discards.white.addCard(self.table.white);
        self.table.white = null;
//        var count = self.table.black.length;
        _.each(self.table.black, function (cards) {
            _.each(cards.getCards(), function (card) {
                card.owner = null;
                self.discards.black.addCard(card);
                cards.removeCard(card);
            }, this);
        }, this);
        self.table.black = [];

        // reset players
        var removedNicks = [];
        _.each(self.players, function (player) {
            player.hasPlayed = false;
            player.isCzar = false;
            // check inactive count & remove after 3
            if (player.inactiveRounds >= 3) {
                self.removePlayer(player, {silent: true});
                removedNicks.push(player.nick);
            }
        });
        if (removedNicks.length > 0) {
            self.say('Removed inactive players: ' + removedNicks.join(', '));
        }
        // reset state
        self.state = STATES.STARTED;
    };

    /**
     * Play new white card on the table
     */
    self.playWhite = function () {
        self.checkDecks();
        var card = self.decks.white.pickCards();
        // replace all instance of %s with underscores for prettier output
        var text = card.text.replace(/\%s/g, '___');
        // check if special pick & draw rules
        if (card.pick > 1) {
            text += c.bold(' [PICK ' + card.pick + ']');
        }
        if (card.draw > 0) {
            text += c.bold(' [DRAW ' + card.draw + ']');
        }
        self.say(c.bold('CARD: ') + text);
        self.table.white = card;
        // draw cards
        if (self.table.white.draw > 0) {
            _.each(_.where(self.players, {isCzar: false}), function (player) {
                for (var i = 0; i < self.table.white.draw; i++) {
                    self.checkDecks();
                    var c = self.decks.black.pickCards();
                    player.cards.addCard(c);
                    c.owner = player;
                }
            });
        }
        // start turn timer, check every 10 secs
        clearInterval(self.turnTimer);
        self.roundStarted = new Date();
        self.turnTimer = setInterval(self.turnTimerCheck, 10 * 1000);
    };

    /**
     * Play a black card from players hand
     * @param cards card indexes in players hand
     * @param player Player who played the cards
     */
    self.playCard = function (cards, player) {
        // don't allow if game is paused
        if (self.state === STATES.PAUSED) {
            self.say('Game is currently paused.');
            return false;
        }

        console.log(player.nick + ' played cards', cards.join(', '));
        // make sure different cards are played
        cards = _.uniq(cards);
        if (self.state !== STATES.PLAYABLE || player.cards.numCards() === 0) {
            self.say(player.nick + ': Can\'t play at the moment.');
        } else if (typeof player !== 'undefined') {
            if (player.isCzar === true) {
                self.say(player.nick + ': You are the card czar. The czar does not play. The czar makes other people do his dirty work.');
            } else {
                if (player.hasPlayed === true) {
                    self.say(player.nick + ': You have already played on this round.');
                } else if (cards.length != self.table.white.pick) {
                    // invalid card count
                    self.say(player.nick + ': You must pick ' + self.table.white.pick + ' different cards.');
                } else {
                    // get played cards
                    var playerCards;
                    try {
                        playerCards = player.cards.pickCards(cards);
                    } catch (error) {
                        self.notice(player.nick, 'Invalid card index');
                        return false;
                    }
                    self.table.black.push(playerCards);
                    player.hasPlayed = true;
                    player.inactiveRounds = 0;
                    self.notice(player.nick, 'You played: ' + self.getFullEntry(self.table.white, playerCards.getCards()));
                    // show entries if all players have played
                    if (self.checkAllPlayed()) {
                        self.showEntries();
                    }
                }
            }
        } else {
            console.warn('Invalid player tried to play a card');
        }
    };

    /**
     * Check the time that has elapsed since the beinning of the turn.
     * End the turn is time limit is up
     */
    self.turnTimerCheck = function () {
        // check the time
        var now = new Date();
        var timeLimit = 3 * 60 * 1000;
        var roundElapsed = (now.getTime() - self.roundStarted.getTime());
        console.log('Round elapsed:', roundElapsed, now.getTime(), self.roundStarted.getTime());
        if (roundElapsed >= timeLimit) {
            console.log('The round timed out');
            self.say('Time is up!');
            self.markInactivePlayers();
            // show end of turn
            self.showEntries();
        } else if (roundElapsed >= timeLimit - (10 * 1000) && roundElapsed < timeLimit) {
            // 10s ... 0s left
            self.say('10 seconds left!');
        } else if (roundElapsed >= timeLimit - (30 * 1000) && roundElapsed < timeLimit - (20 * 1000)) {
            // 30s ... 20s left
            self.say('30 seconds left!');
        } else if (roundElapsed >= timeLimit - (60 * 1000) && roundElapsed < timeLimit - (50 * 1000)) {
            // 60s ... 50s left
            self.say('Hurry up, 1 minute left!');
        }
    };

    /**
     * Show the entries
     */
    self.showEntries = function () {
        // clear round timer
        clearInterval(self.turnTimer);

        self.state = STATES.PLAYED;
        // Check if 2 or more entries...
        if (self.table.black.length === 0) {
            self.say('No one played on this round.');
            // skip directly to next round
            self.clean();
            self.nextRound();
        } else if (self.table.black.length === 1) {
            self.say('Only one player played and is the winner by default.');
            self.selectWinner(0);
        } else {
            self.say('Everyone has played. Here are the entries:');
            // shuffle the entries
            self.table.black = _.shuffle(self.table.black);
            _.each(self.table.black, function (cards, i) {
                self.say(i + ": " + self.getFullEntry(self.table.white, cards.getCards()));
            }, this);
            // check that czar still exists
            var currentCzar = _.findWhere(this.players, {isCzar: true});
            if (typeof currentCzar === 'undefined') {
                // no czar, random winner (TODO: Voting?)
                self.say('The czar has fled the scene. So I will pick the winner on this round.');
                self.selectWinner(Math.round(Math.random() * (self.table.black.length - 1)));
            } else {
                self.say(self.czar.nick + ': Select the winner (!winner <entry number>)');
                // start turn timer, check every 10 secs
                clearInterval(self.winnerTimer);
                self.roundStarted = new Date();
                self.winnerTimer = setInterval(self.winnerTimerCheck, 10 * 1000);
            }

        }
    };

    /**
     * Check the time that has elapsed since the beinning of the winner select.
     * End the turn is time limit is up
     */
    self.winnerTimerCheck = function () {
        // check the time
        var now = new Date();
        var timeLimit = 2 * 60 * 1000;
        var roundElapsed = (now.getTime() - self.roundStarted.getTime());
        console.log('Winner selecgtion elapsed:', roundElapsed, now.getTime(), self.roundStarted.getTime());
        if (roundElapsed >= timeLimit) {
            console.log('the czar is inactive, selecting winner');
            self.say('Time is up. I will pick the winner on this round.');
            // Check czar & remove player after 3 timeouts
            self.czar.inactiveRounds++;
            // select winner
            self.selectWinner(Math.round(Math.random() * (self.table.black.length - 1)));
        } else if (roundElapsed >= timeLimit - (10 * 1000) && roundElapsed < timeLimit) {
            // 10s ... 0s left
            self.say(self.czar.nick + ': 10 seconds left!');
        } else if (roundElapsed >= timeLimit - (30 * 1000) && roundElapsed < timeLimit - (20 * 1000)) {
            // 30s ... 20s left
            self.say(self.czar.nick + ': 30 seconds left!');
        } else if (roundElapsed >= timeLimit - (60 * 1000) && roundElapsed < timeLimit - (50 * 1000)) {
            // 60s ... 50s left
            self.say(self.czar.nick + ': Hurry up, 1 minute left!');
        }
    };

    /**
     * Pick an entry that wins the round
     * @param index Index of the winning card in table list
     * @param player Player who said the command (use null for internal calls, to ignore checking)
     */
    self.selectWinner = function (index, player) {
        // don't allow if game is paused
        if (self.state === STATES.PAUSED) {
            self.say('Game is currently paused.');
            return false;
        }

        // clear winner timer
        clearInterval(self.winnerTimer);

        var winner = self.table.black[index];
        if (self.state === STATES.PLAYED) {
            if (typeof player !== 'undefined' && player !== self.czar) {
                client.say(player.nick + ': You are not the card czar. Only the card czar can select the winner');
            } else if (typeof winner === 'undefined') {
                self.say('Invalid winner');
            } else {
                self.state = STATES.ROUND_END;
                var owner = winner.cards[0].owner;
                owner.points++;
                // update points object
                _.findWhere(self.points, {player: owner}).points = owner.points;
                // announce winner
                self.say(c.bold('Winner is: ') + owner.nick + ' with "' + self.getFullEntry(self.table.white, winner.getCards()) + '" and gets one awesome point! ' + owner.nick + ' has ' + owner.points + ' awesome points.');
                self.clean();
                self.nextRound();
            }
        }
    };

    /**
     * Get formatted entry
     * @param white
     * @param blacks
     * @returns {*|Object|ServerResponse}
     */
    self.getFullEntry = function (white, blacks) {
        var args = [white.text];
        _.each(blacks, function (card) {
            args.push(card.text);
        }, this);
        return util.format.apply(this, args);
    };

    /**
     * Check if all active players played on the current round
     * @returns Boolean true if all players have played
     */
    self.checkAllPlayed = function () {
        var allPlayed = false;
        if (self.getNotPlayed().length === 0) {
            allPlayed = true;
        }
        return allPlayed;
    };

    /**
     * Check if decks are empty & reset with discards
     */
    self.checkDecks = function () {
        // check black deck
        if (self.decks.black.numCards() === 0) {
            console.log('black deck is empty. reset from discard.');
            self.decks.black.reset(self.discards.black.reset());
            self.decks.black.shuffle();
            console.log(self.decks.black.numCards());
        }
        // check white deck
        if (self.decks.white.numCards() === 0) {
            console.log('white deck is empty. reset from discard.');
            self.decks.white.reset(self.discards.white.reset());
            self.decks.white.shuffle();
            console.log(self.decks.white.numCards());
        }
    };

    /**
     * Add a player to the game
     * @param player Player object containing new player's data
     * @returns The new player or false if invalid player
     */
    self.addPlayer = function (player) {
        if (typeof self.getPlayer({nick: player.nick, hostname: player.hostname}) === 'undefined') {
            self.players.push(player);
            self.say(player.nick + ' has joined the game');
            // check if player is returning to game
            var pointsPlayer = _.findWhere(self.points, {nick: player.nick, hostname: player.hostname});
            if (typeof pointsPlayer === 'undefined') {
                // new player
                self.points.push({
                    nick:     player.nick, // nick and hostname are used for matching returning players
                    hostname: player.hostname,
                    player:   player, // reference to player object saved to points object as well
                    points:   0
                });
            } else {
                // returning player
                pointsPlayer.player = player;
                player.points = pointsPlayer.points;
            }
            // check if waiting for players
            if (self.state === STATES.WAITING && self.players.length >= 3) {
                // enough players, start the game
                self.nextRound();
            }
            return player;
        } else {
            console.log('Player tried to join again', player.nick, player.hostname);
        }
        return false;
    };

    /**
     * Find player
     * @param search
     * @returns {*}
     */
    self.getPlayer = function (search) {
        return _.findWhere(self.players, search);
    };

    /**
     * Remove player from game
     * @param player
     * @param options Extra options
     * @returns The removed player or false if invalid player
     */
    self.removePlayer = function (player, options) {
        options = _.extend({}, options);
        if (typeof player !== 'undefined') {
            self.players = _.without(self.players, player);
            if (options.silent !== true) {
                self.say(player.nick + ' has left the game');
            }

            // check if remaining players have all player
            if (self.state === STATES.PLAYABLE && self.checkAllPlayed()) {
                self.showEntries();
            }

            // check czar
            if (self.state === STATES.PLAYED && self.czar === player) {
                self.say('The czar has fled the scene. So I will pick the winner on this round.');
                self.selectWinner(Math.round(Math.random() * (self.table.black.length - 1)));
            }

            return player;
        }
        return false;
    };

    /**
     * Get all player who have not played
     * @returns Array list of Players that have not played
     */
    self.getNotPlayed = function () {
        return _.where(_.filter(self.players, function (player) {
            // check only players with cards (so players who joined in the middle of a round are ignored)
            return player.cards.numCards() > 0;
        }), {hasPlayed: false, isCzar: false});
    };

    /**
     * Check for inactive players
     * @param options
     */
    self.markInactivePlayers = function (options) {
        _.each(self.getNotPlayed(), function (player) {
            player.inactiveRounds++;
        }, this);
    };

    /**
     * Show players cards to player
     * @param player
     */
    self.showCards = function (player) {
        if (typeof player !== 'undefined') {
            var cards = "";
            _.each(player.cards.getCards(), function (card, index) {
                cards += c.bold(' [' + index + '] ') + card.text;
            }, this);
            self.notice(player.nick, 'Your cards are:' + cards);
        }
    };

    /**
     * Show points for all players
     */
    self.showPoints = function () {
        var sortedPlayers = _.sortBy(self.points, function (point) {
            return -point.player.points;
        });
        var output = "";
        _.each(sortedPlayers, function (point) {
            output += point.player.nick + " " + point.points + " awesome points, ";
        });
        self.say('The most horrible people: ' + output.slice(0, -2));
    };

    /**
     * Show status
     */
    self.showStatus = function () {
        var playersNeeded = Math.max(0, 3 - self.players.length), // amount of player needed to start the game
            timeLeft = 30 - Math.round((new Date().getTime() - self.startTime.getTime()) / 1000), // time left until first round
            activePlayers = _.filter(self.players, function (player) {
                // only players with cards in hand are active
                return player.cards.numCards() > 0;
            }),
            played = _.where(activePlayers, {isCzar: false, hasPlayed: true}), // players who have already played
            notPlayed = _.where(activePlayers, {isCzar: false, hasPlayed: false}); // players who have not played yet
        switch (self.state) {
            case STATES.PLAYABLE:
                self.say(c.bold('Status: ') + self.czar.nick + ' is the czar. Waiting for players to play: ' + _.pluck(notPlayed, 'nick').join(', '));
                break;
            case STATES.PLAYED:
                self.say(c.bold('Status: ') + 'Waiting for ' + self.czar.nick + ' to select the winner.');
                break;
            case STATES.ROUND_END:
                self.say(c.bold('Status: ') + 'Round has ended and next one is starting.');
                break;
            case STATES.STARTED:
                self.say(c.bold('Status: ') + 'Game starts in ' + timeLeft + ' seconds. Need ' + playersNeeded + ' more players to start.');
                break;
            case STATES.STOPPED:
                self.say(c.bold('Status: ') + 'Game has been stopped.');
                break;
            case STATES.WAITING:
                self.say(c.bold('Status: ') + 'Not enough players to start. Need ' + playersNeeded + ' more players to start.');
                break;
        }
    };

    /**
     * List all players in the current game
     */
    self.listPlayers = function () {
        self.say('Players currently in the game: ' + _.pluck(self.players, 'nick').join(', '));
    };

    /**
     * Handle player quits and parts
     * @param channel
     * @param nick
     * @param reason
     * @param message
     */
    self.playerLeaveHandler = function (channel, nick, reason, message) {
        console.log('Player ' + nick + ' left');
        var player = self.getPlayer({nick: nick});
        if (typeof player !== 'undefined') {
            self.removePlayer(player);
        }
    };

    /**
     * Handle player nick changes
     * @param oldnick
     * @param newnick
     * @param channels
     * @param message
     */
    self.playerNickChangeHandler = function (oldnick, newnick, channels, message) {
        console.log('Player changed nick from ' + oldnick + ' to ' + newnick);
        var player = self.getPlayer({nick: oldnick});
        if (typeof player !== 'undefined') {
            player.nick = newnick;
        }
    };

    /**
     * Public message to the game channel
     * @param string
     */
    self.say = function (string) {
        self.client.say(self.channel, string);
    };

    self.pm = function (nick, string) {
        self.client.say(nick, string);
    };

    self.notice = function (nick, string) {
        self.client.notice(nick, string);
    };

    // announce the game on the channel
    self.say('A new game of ' + c.rainbow('Cards Against Humanity') + '. The game starts in 30 seconds. Type !join to join the game any time.');

    // wait for players to join
    self.startTime = new Date();
    self.startTimeout = setTimeout(self.nextRound, 30000);

    // client listeners
    client.addListener('part', self.playerLeaveHandler);
    client.addListener('quit', self.playerLeaveHandler);
    client.addListener('nick', self.playerNickChangeHandler);
};

exports = module.exports = Game;