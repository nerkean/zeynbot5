require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const CommandStats = require('../CommandStats');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const session = require('express-session');
const { fetch } = require('undici');
const Item = require('../Item');
const Inventory = require('../inventory');
const Counter = require('../counter');
const { Client, IntentsBitField } = require('discord.js');
const NodeCache = require('node-cache');
const rateLimit = require("express-rate-limit");

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 300, 
  message: "Слишком много запросов с вашего IP, пожалуйста, попробуйте позже.",
  handler: (req, res, next, options) => {
    res.status(429).setHeader('Retry-After', Math.ceil(options.windowMs / 1000)).send(options.message);
  }
});

const cache = new NodeCache({ stdTTL: 60 * 60 });
const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMembers,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent,
        IntentsBitField.Flags.GuildMessageReactions
    ],
});

const app = express();
const PORT = process.env.PORT || 10000;
const LEADERBOARD_CACHE_TTL = 5 * 60;

const corsOptions = {
    origin: 'https://bandazeyna.com',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200,
    credentials: true
};
app.use(cors(corsOptions));

app.use(limiter);

app.use(express.json());

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('💾 Подключено к MongoDB'))
    .catch(err => console.error('Ошибка подключения:', err));

exports.handler = async function (event, context) {
    app.use(session({
        secret: process.env.SESSION_SECRET, 
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: false, 
            maxAge: 24 * 60 * 60 * 1000,
        }
    }));
    app.use(passport.initialize());
    app.use(passport.session());

    passport.serializeUser((user, done) => {
        console.log("Сериализация пользователя:", user._id);
        done(null, user._id);
    });
    
    passport.deserializeUser(async (id, done) => {
        console.log("Десериализация пользователя:", id);
        try {
            const user = await CommandStats.findById(id);
            if (!user) {
                console.log("Пользователь не найден при десериализации");
                return done(new Error('User not found'));
            }
            console.log("Десериализованный пользователь:", user);
            done(null, user);
        } catch (err) {
            console.error("Ошибка при десериализации пользователя:", err);
            done(err);
        }
    });
    
const allowedRoleIds = ['1043565185509630022', '1243243180800082001', '1075072592005824563', '1043614651444899991', '1043615386660257872'];
const GUILD_ID = '1043562997966188645';
const BOT_TOKEN = process.env.TOKEN

let userGuildMemberCache = {};

async function fetchUserGuildMember(userId) {
    console.log(`Попытка получить пользователя ${userId} из кэша`);
    if (userGuildMemberCache[userId]) {
        console.log(`Пользователь ${userId} найден в кэше`);
        return userGuildMemberCache[userId];
    }
    try {
        console.log(`Запрос данных пользователя ${userId} с Discord API`);
        const response = await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${userId}`, {
            headers: {
                Authorization: `Bot ${BOT_TOKEN}`,
            },
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error(`Ошибка получения данных пользователя ${userId}: ${response.status} ${response.statusText}`, errorData);
            throw new Error(`Failed to fetch user guild member: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log(`Данные пользователя ${userId} успешно получены:`, data);
        userGuildMemberCache[userId] = data;
        return data;
    } catch (error) {
        console.error(error);
        return null;
    }
}

passport.use(new DiscordStrategy({
    clientID: '1193621998505566350',
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: 'http://localhost:3000/auth/callback',
    scope: ['identify', 'guilds.members.read']
},
async (accessToken, refreshToken, profile, done) => {
    console.log("Сработал обратный вызов Discord Strategy");
    try {
        console.log("Профиль с дискорда:", profile);
        let user = await CommandStats.findOne({ userId: profile.id, serverId: GUILD_ID }).lean();

        if (!user) {
            console.log("Новый пользователь, создание записи в БД");
            user = new CommandStats({
                userId: profile.id,
                serverId: GUILD_ID,
                username: profile.username,
                userAvatar: profile.avatar,
                roleAcquisitionDates: {}
            });
        } else {
            console.log("Существующий пользователь, обновление данных");
            user.username = profile.username;
            user.userAvatar = profile.avatar;
        }

        const userGuildMember = await fetchUserGuildMember(profile.id);
        if (!userGuildMember) {
            console.error('Не удалось получить данные пользователя с сервера Discord');
            return done(new Error('Failed to fetch user guild member')); 
        }

        const userRolesIds = userGuildMember.roles;
        const roleAcquisitionDates = {};
        const now = new Date();

        for (const allowedRoleId of allowedRoleIds) {
            if (userRolesIds.includes(allowedRoleId)) {
                roleAcquisitionDates[allowedRoleId] = now;
            }
        }

        user.roleAcquisitionDates = roleAcquisitionDates;
        console.log("Данные пользователя перед сохранением:", user);
        await CommandStats.updateOne({ userId: profile.id, serverId: GUILD_ID }, user, { upsert: true });
        console.log("Данные пользователя успешно сохранены/обновлены");

        return done(null, user);
    } catch (err) {
        console.error("Ошибка в Discord Strategy:", err);
        return done(err);
    }
}));

let leaderboardUpdateTimestamp = Date.now();

app.get('/leaderboard', async (req, res) => {
    try {
        const sortBy = req.query.sortBy || 'totalMessages';
        const cacheKey = `leaderboard_${sortBy}`;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const cachedData = cache.get(cacheKey);
        if (cachedData && Date.now() - cachedData.timestamp < LEADERBOARD_CACHE_TTL * 1000) {
            return res.json({
                data: cachedData.data,
                nextUpdateIn: Math.max(0, LEADERBOARD_CACHE_TTL * 1000 - (Date.now() - cachedData.timestamp))
            });
        }

        let sortOption = {};
        if (sortBy === 'voiceTime') {
            sortOption = { voiceTime: -1 };
        } else if (sortBy === 'stars') {
            sortOption = { stars: -1 };
        } else {
            sortOption = { totalMessages: -1 };
        }

        const topUsers = await CommandStats.find({})
            .sort(sortOption)
            .skip(skip)
            .limit(limit)
            .select('username totalMessages voiceTime stars')
            .lean();

        cache.set(cacheKey, { data: topUsers, timestamp: Date.now() }, LEADERBOARD_CACHE_TTL);

        res.json({
            data: topUsers,
            nextUpdateIn: LEADERBOARD_CACHE_TTL * 1000
        });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/profile/:uuid', async (req, res) => {
    try {
        const uuid = req.params.uuid;
        const cacheKey = `profile_${uuid}`;

        const cachedProfile = cache.get(cacheKey);
        if (cachedProfile) {
            return res.json(cachedProfile);
        }

        const userStats = await CommandStats.findOne({ uuid }).select('-__v').lean();

        if (!userStats) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const userId = userStats.userId;

        const userGuildMember = await fetchUserGuildMember(userId);
        if (!userGuildMember) {
            throw new Error('Failed to fetch user guild member');
        }
        
        const userRolesIds = userGuildMember.roles || [];

        const userRankAllTime = await CommandStats.countDocuments({ totalMessages: { $gt: userStats.totalMessages } }) + 1;
        const userRankToday = await CommandStats.countDocuments({ messagesToday: { $gt: userStats.messagesToday } }) + 1;
        const userRankLast7Days = await CommandStats.countDocuments({ messagesLast7Days: { $gt: userStats.messagesLast7Days } }) + 1;
        const userRankLast30Days = await CommandStats.countDocuments({ messagesLast30Days: { $gt: userStats.messagesLast30Days } }) + 1;
        const userRoles = Object.keys(userStats.roleAcquisitionDates).filter(roleId => allowedRoleIds.includes(roleId));

        const achievements = [
            { name: 'message_master', description: 'Написать 500 сообщений за 24 часа', target: 500 },
            { name: 'voice_champion', description: 'Попасть в топ 1 за 24 часа по голосовому времени' },
            { name: 'lovebird', description: 'Создать брак через бота' },
            { name: 'voice_time_10s', description: 'Просидеть 1 час в голосовом канале подряд', target: 3600 },
        ];

        const userAchievements = achievements.map(achievement => {
            let progress = 0;
            let completed = false;

            if (achievement.name === 'message_master') {
                progress = userStats.messagesToday;
                completed = userStats.achievements.some(a => a.name === achievement.name && a.completed);
            } else if (achievement.name === 'voice_time_10s') {
                progress = Math.floor(userStats.voiceTime / 1000);
                completed = userStats.achievements.some(a => a.name === achievement.name && a.completed);
            } else {
                completed = userStats.achievements.some(a => a.name === achievement.name && a.completed);
            }

            return {
                ...achievement,
                progress: progress,
                completed: completed
            };
        });

        const profileData = {
            ...userStats,
            userAvatar: userStats.userAvatar,
            userRankAllTime,
            userRankToday,
            userRankLast7Days,
            userRankLast30Days,
            roles: userRolesIds,
            achievements: userAchievements
        };

        cache.set(cacheKey, profileData, 300);
        res.json(profileData);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/achievements', async (req, res) => {
    try {
        const achievements = [
            { name: 'message_master', description: 'Написать 500 сообщений за 24 часа', target: 500 },
            { name: 'voice_champion', description: 'Попасть в топ 1 за 24 часа по голосовому времени' },
            { name: 'lovebird', description: 'Создать брак через бота' },
            { name: 'voice_time_10s', description: 'Просидеть 1 час в голосовом канале подряд', target: 3600 },
        ];

        res.json(achievements);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/achievements/:uuid', async (req, res) => {
    try {
        const uuid = req.params.uuid;
        const cacheKey = `achievements_${uuid}`;

        const cachedAchievements = cache.get(cacheKey);
        if (cachedAchievements) {
            return res.json(cachedAchievements);
        }

        const userStats = await CommandStats.findOne({ uuid });
        if (!userStats) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const achievements = [
            { name: 'message_master', description: 'Написать 500 сообщений за 24 часа', target: 500 },
            { name: 'voice_champion', description: 'Попасть в топ 1 за 24 часа по голосовому времени' },
            { name: 'lovebird', description: 'Создать брак через бота' },
            { name: 'voice_time_10s', description: 'Просидеть 1 час в голосовом канале подряд', target: 3600 },
        ];

        const userAchievements = achievements.map(achievement => {
            let progress = 0;
            let completed = false;

            if (achievement.name === 'message_master') {
                progress = userStats.messagesToday;
                completed = userStats.achievements.some(a => a.name === achievement.name && a.completed);
            } else if (achievement.name === 'voice_time_10s') {
                progress = Math.floor(userStats.voiceTime / 1000);
                completed = userStats.achievements.some(a => a.name === achievement.name && a.completed);
            } else {
                completed = userStats.achievements.some(a => a.name === achievement.name && a.completed);
            }

            return {
                ...achievement,
                progress: progress,
                completed: completed
            };
        });

        cache.set(cacheKey, userAchievements, 300); 
        res.json(userAchievements);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/shop', async (req, res) => {
    try {
        const items = await Item.find();
        res.json(items);
    } catch (error) {
        console.error('Ошибка при получении данных магазина:', error);
        res.status(500).json({ error: 'Ошибка при получении данных магазина' });
    }
});

app.get('/profile/:userId/messagesByDate', async (req, res) => {
    try {
        const userId = req.params.userId;
        const userStats = await CommandStats.findOne({ userId });

        if (!userStats) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        res.json(userStats.messagesByDate);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/buy', async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { uuid, userId, itemName, quantity } = req.body;

        const user = await CommandStats.findOne({ uuid, userId }).session(session);
        if (!user) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ error: 'Пользователь не найден. Если вы изменили userId в хранилище, то верните его пожалуйста :)))))' });
        }

        const item = await Item.findOne({ name: itemName }).session(session);
        if (!item) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ error: 'Товар не найден' });
        }

        if (item.stock !== -1 && item.stock < quantity) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ error: 'Недостаточно товара в наличии' });
        }

        const today = new Date().getDay();
        const isDiscountDay = today === 0 || today === 6;
        let discountPercentage = isDiscountDay ? 5 : 0;

        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(userId);

        const hasPermanentDiscountRole = member.roles.cache.has('1260383669839724634');
        if (hasPermanentDiscountRole) {
            discountPercentage += 20;
        }

        const discountedPrice = Math.round(item.price * (1 - discountPercentage / 100));

        if (user.stars < discountedPrice * quantity) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ error: 'Недостаточно звезд' });
        }

        user.stars -= discountedPrice * quantity;
        await user.save({ session });

        if (item.stock !== -1) {
            item.stock -= quantity;
            await item.save({ session });
        }

        let inventory = await Inventory.findOne({ userId }).session(session);
        if (!inventory) {
            inventory = new Inventory({ userId, items: [] });
        }

        const existingItemIndex = inventory.items.findIndex(i => i.itemId.toString() === item._id.toString());
        if (existingItemIndex !== -1) {
            inventory.items[existingItemIndex].quantity += quantity;
        } else {
            inventory.items.push({ itemId: item._id, itemName: item.name, quantity });
        }
        await inventory.save({ session });

        await session.commitTransaction();
        res.json({ message: `Вы успешно купили ${quantity}x ${item.name} за ${discountedPrice * quantity} звезд!` });
    } catch (error) {
        await session.abortTransaction();
        console.error('Ошибка при покупке товара:', error);
        res.status(500).json({ error: 'Ошибка при покупке товара' });
    } finally {
        session.endSession();
    }
});

app.get('/auth/discord', (req, res, next) => {
    passport.authenticate('discord')(req, res, next)
});

app.get('/auth/callback',
    passport.authenticate('discord', { failureRedirect: '/' }), 
    async (req, res) => {
        try {
            const user = await CommandStats.findOne({ userId: req.user.userId }).select('uuid');
            if (!user) {
                return res.status(404).send('User not found');
            }
            res.redirect(`http://127.0.0.1:5500/index.html?uuid=${user.uuid}`);
        } catch (error) {
            console.error("Error in /auth/callback:", error);
            res.status(500).send("An error occurred during authentication.");
        }
    }
);

app.get('/logout', (req, res) => {
    req.logout(err => {
        if (err) {
            console.error('Ошибка при выходе из системы:', err);
            return res.status(500).send('Ошибка при выходе из системы');
        }
        res.redirect('/');
    });
});

app.get('/', async (req, res) => {
    try {
      let counter = await Counter.findOne();
  
      if (!counter) {
        counter = new Counter({ count: 0 });
      }
  
      counter.count++;

      await counter.save();

    } catch (err) {
      console.error('Error updating counter:', err);
      res.status(500).send('Internal Server Error');
    }
  });

app.listen(PORT, () => {
    console.log(`🚀 API сервер запущен на порту ${PORT}`);
});

client.on('ready', () => {
    console.log(`Бот Discord готов к работе: ${client.user.tag}`);
});

client.login(process.env.TOKEN);
}
