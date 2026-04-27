import React, { useState, useEffect, useMemo } from 'react';
import { 
  Plus, 
  Trash2, 
  Search, 
  TrendingDown, 
  History, 
  Cpu, 
  LogOut, 
  LogIn, 
  ChevronRight, 
  Package, 
  CheckCircle2, 
  AlertCircle,
  Loader2,
  FileText,
  Filter,
  Circle,
  Sun,
  Moon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { 
  collection, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  query, 
  orderBy, 
  setDoc,
  writeBatch,
  getDocs
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { GoogleGenAI, Type } from "@google/genai";
import { db, auth, signIn, logout } from './firebase';
import { Product, Sale, RawInput, OperationType, FirestoreErrorInfo, Installment } from './types';

// --- Error Handling ---
function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- App Component ---
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<'inventory' | 'sales' | 'ai' | 'history'>('inventory');
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [rawInputs, setRawInputs] = useState<RawInput[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [historySearchTerm, setHistorySearchTerm] = useState('');
  const [materialFilter, setMaterialFilter] = useState<string>('Todos');
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [aiPreviewData, setAiPreviewData] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedProductForSale, setSelectedProductForSale] = useState<Product | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | '2x' | '3x'>('cash');
  const [installmentToToggle, setInstallmentToToggle] = useState<{ saleId: string, installmentNumber: number, currentStatus: 'paid' | 'pending' } | null>(null);
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('theme') === 'dark' || 
        (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    return false;
  });

  // --- Theme Effect ---
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [darkMode]);

  // --- Auth Listener ---
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
  }, []);

  // --- Firestore Listeners ---
  useEffect(() => {
    if (!user || !isAuthReady) return;

    const unsubInventory = onSnapshot(collection(db, 'inventory'), (snapshot) => {
      setProducts(snapshot.docs.map(doc => ({ ...doc.data() } as Product)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'inventory'));

    const unsubSales = onSnapshot(query(collection(db, 'sales_history'), orderBy('date', 'desc')), (snapshot) => {
      setSales(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Sale)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'sales_history'));

    const unsubRaw = onSnapshot(query(collection(db, 'raw_inputs'), orderBy('uploadDate', 'desc')), (snapshot) => {
      setRawInputs(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as RawInput)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'raw_inputs'));

    return () => {
      unsubInventory();
      unsubSales();
      unsubRaw();
    };
  }, [user, isAuthReady]);

  // --- AI Processing ---
  const handleAIPreview = async () => {
    if (!aiInput.trim()) return;
    setIsProcessingAI(true);
    setError(null);
    setAiPreviewData(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: aiInput,
        config: {
          systemInstruction: `Você é um especialista em inventário de semijoias. 
          Receba uma lista de semijoias, ignore a linha 'TOTAL GERAL'.
          Identifique o Código (id), Categoria, Quantidade (initialQuantity) e Valor (unitValue).
          Extraia se o material é Ouro, Prata ou Ródio do nome da categoria ou do contexto.
          Retorne obrigatoriamente um JSON estruturado como um ARRAY de objetos com as chaves: id, category, material, initialQuantity, currentQuantity, unitValue.
          currentQuantity deve ser igual a initialQuantity inicialmente.`,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                category: { type: Type.STRING },
                material: { type: Type.STRING },
                initialQuantity: { type: Type.NUMBER },
                currentQuantity: { type: Type.NUMBER },
                unitValue: { type: Type.NUMBER }
              },
              required: ["id", "category", "material", "initialQuantity", "currentQuantity", "unitValue"]
            }
          }
        }
      });

      const parsedData = JSON.parse(response.text);
      setAiPreviewData(parsedData);
    } catch (err) {
      console.error(err);
      setError("Erro ao processar com IA. Verifique o formato do texto.");
    } finally {
      setIsProcessingAI(false);
    }
  };

  const commitAICatalog = async () => {
    if (!aiPreviewData) return;
    setIsProcessingAI(true);

    try {
      const batch = writeBatch(db);
      
      // Add new products record
      await addDoc(collection(db, 'raw_inputs'), {
        originalText: aiInput,
        status: 'processed',
        uploadDate: new Date().toISOString()
      });

      // Add new products (append mode)
      aiPreviewData.forEach((p: Product) => {
        const docRef = doc(db, 'inventory', p.id);
        batch.set(docRef, p);
      });

      await batch.commit();
      setAiInput('');
      setAiPreviewData(null);
      setActiveTab('inventory');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'inventory');
    } finally {
      setIsProcessingAI(false);
    }
  };

  // --- Sale Action ---
  const handleSale = async () => {
    if (!selectedProductForSale || !customerName.trim()) return;
    
    if (selectedProductForSale.currentQuantity <= 0) {
      alert("Estoque esgotado!");
      return;
    }

    try {
      const batch = writeBatch(db);
      
      // Decrease quantity
      const productRef = doc(db, 'inventory', selectedProductForSale.id);
      batch.update(productRef, {
        currentQuantity: selectedProductForSale.currentQuantity - 1
      });

      // Generate installments
      const numInstallments = paymentMethod === 'cash' ? 1 : (paymentMethod === '2x' ? 2 : 3);
      const installmentValue = selectedProductForSale.unitValue / numInstallments;
      const installments: Installment[] = [];

      for (let i = 1; i <= numInstallments; i++) {
        const dueDate = new Date();
        // Set to day 10 of next month(s)
        dueDate.setMonth(dueDate.getMonth() + i);
        dueDate.setDate(10);
        
        installments.push({
          number: i,
          dueDate: dueDate.toISOString(),
          value: installmentValue,
          status: paymentMethod === 'cash' ? 'paid' : 'pending'
        });
      }

      // Add to history
      const saleRef = doc(collection(db, 'sales_history'));
      batch.set(saleRef, {
        date: new Date().toISOString(),
        productId: selectedProductForSale.id,
        category: selectedProductForSale.category,
        saleValue: selectedProductForSale.unitValue,
        customerName: customerName.trim(),
        paymentMethod: paymentMethod,
        installments: installments
      });

      await batch.commit();
      setSelectedProductForSale(null);
      setCustomerName('');
      setPaymentMethod('cash');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'inventory');
    }
  };

  const toggleInstallmentStatus = (saleId: string, installmentNumber: number, currentStatus: 'paid' | 'pending') => {
    setInstallmentToToggle({ saleId, installmentNumber, currentStatus });
  };

  const confirmToggle = async () => {
    if (!installmentToToggle) return;
    const { saleId, installmentNumber } = installmentToToggle;
    const sale = sales.find(s => s.id === saleId);
    if (!sale) return;

    const updatedInstallments = sale.installments.map(inst => {
      if (inst.number === installmentNumber) {
        return { ...inst, status: inst.status === 'paid' ? 'pending' : 'paid' as 'paid' | 'pending' };
      }
      return inst;
    });

    try {
      const saleRef = doc(db, 'sales_history', saleId);
      await updateDoc(saleRef, { installments: updatedInstallments });
      setInstallmentToToggle(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sales_history/${saleId}`);
    }
  };

  // --- Filtering ---
  const filteredProducts = useMemo(() => {
    return products.filter(p => {
      const matchesSearch = p.id.toLowerCase().includes(searchTerm.toLowerCase()) || 
                            p.category.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesMaterial = materialFilter === 'Todos' || p.material === materialFilter;
      return matchesSearch && matchesMaterial;
    });
  }, [products, searchTerm, materialFilter]);

  const filteredSales = useMemo(() => {
    return sales.filter(s => {
      const matchesSearch = s.customerName.toLowerCase().includes(historySearchTerm.toLowerCase()) || 
                            s.productId.toLowerCase().includes(historySearchTerm.toLowerCase()) ||
                            s.category.toLowerCase().includes(historySearchTerm.toLowerCase());
      return matchesSearch;
    });
  }, [sales, historySearchTerm]);

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-neutral-100 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-neutral-400" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-neutral-100 flex flex-col items-center justify-center p-6 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full"
        >
          <div className="w-16 h-16 bg-neutral-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Package className="text-white w-8 h-8" />
          </div>
          <h1 className="text-3xl font-bold text-neutral-900 mb-2">GI Semijoias</h1>
          <p className="text-neutral-500 mb-8">Controle de estoque inteligente e simplificado.</p>
          <button 
            onClick={signIn}
            className="w-full bg-neutral-900 text-white py-4 rounded-2xl font-semibold flex items-center justify-center gap-3 hover:bg-neutral-800 transition-colors"
          >
            <LogIn className="w-5 h-5" />
            Entrar com Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 font-sans pb-24 transition-colors duration-300">
      {/* Header */}
      <header className="bg-white dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 px-6 py-4 sticky top-0 z-10 transition-colors">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-neutral-900 dark:bg-white rounded-xl flex items-center justify-center">
              <Package className="text-white dark:text-neutral-900 w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">GI Semijoias</h1>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setDarkMode(prev => !prev)}
              className="p-2 text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors"
              title={darkMode ? "Mudar para modo claro" : "Mudar para modo escuro"}
            >
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button 
              onClick={logout}
              className="p-2 text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {/* Tabs */}
        <div className="flex gap-2 mb-8 overflow-x-auto pb-2 scrollbar-hide">
          {[
            { id: 'inventory', label: 'Estoque', icon: Package },
            { id: 'ai', label: 'Processar IA', icon: Cpu },
            { id: 'history', label: 'Histórico', icon: History },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-6 py-3 rounded-2xl font-medium transition-all whitespace-nowrap ${
                activeTab === tab.id 
                ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 shadow-lg shadow-neutral-200 dark:shadow-none' 
                : 'bg-white dark:bg-neutral-900 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {activeTab === 'inventory' && (
            <motion.div
              key="inventory"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="space-y-6"
            >
              {/* Summary Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Total Itens', value: products.length, icon: Package },
                  { label: 'Estoque Total', value: products.reduce((acc, p) => acc + p.currentQuantity, 0), icon: Filter },
                  { label: 'Valor Total', value: products.reduce((acc, p) => acc + (p.currentQuantity * p.unitValue), 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), icon: TrendingDown },
                  { label: 'Vendas Hoje', value: sales.filter(s => format(new Date(s.date), 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd')).length, icon: History },
                ].map((stat, i) => (
                  <div key={i} className="bg-white dark:bg-neutral-900 p-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 shadow-sm">
                    <p className="text-[10px] uppercase tracking-widest text-neutral-400 font-bold mb-1">{stat.label}</p>
                    <p className="text-xl font-black text-neutral-900 dark:text-white">{stat.value}</p>
                  </div>
                ))}
              </div>

              {/* Filters */}
              <div className="flex flex-col md:flex-row gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400 w-5 h-5" />
                  <input 
                    type="text"
                    placeholder="Buscar por código ou categoria..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-12 pr-4 py-4 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:focus:ring-white/10 text-neutral-900 dark:text-white"
                  />
                </div>
                <div className="flex gap-2">
                  {['Todos', 'Ouro', 'Prata', 'Ródio'].map(m => (
                    <button
                      key={m}
                      onClick={() => setMaterialFilter(m)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                        materialFilter === m 
                        ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900' 
                        : 'bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              {/* Product Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredProducts.map((p) => (
                  <motion.div 
                    layout
                    key={p.id}
                    className="bg-white dark:bg-neutral-900 p-6 rounded-3xl border border-neutral-200 dark:border-neutral-800 shadow-sm hover:shadow-md transition-shadow"
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <span className="text-xs font-bold text-neutral-400 uppercase tracking-widest">{p.id}</span>
                        <h3 className="text-lg font-bold text-neutral-900 dark:text-white">{p.category}</h3>
                        <span className={`inline-block px-2 py-1 rounded-lg text-[10px] font-bold uppercase mt-1 ${
                          p.material === 'Ouro' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' :
                          p.material === 'Prata' ? 'bg-slate-100 dark:bg-slate-800/50 text-slate-700 dark:text-slate-400' :
                          'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400'
                        }`}>
                          {p.material}
                        </span>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-neutral-400">Preço</p>
                        <p className="text-lg font-bold text-neutral-900 dark:text-white">
                          {p.unitValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                        </p>
                        <p className="text-[10px] text-green-600 dark:text-green-400 font-bold">
                          2x de {(p.unitValue / 2).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} • 3x de {(p.unitValue / 3).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} s/ juros
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between mt-6 pt-6 border-t border-neutral-100 dark:border-neutral-800">
                      <div className="flex flex-col">
                        <span className="text-xs text-neutral-400 uppercase font-bold tracking-tighter">Estoque</span>
                        <span className={`text-2xl font-black ${p.currentQuantity === 0 ? 'text-red-500' : 'text-neutral-900 dark:text-white'}`}>
                          {p.currentQuantity}
                        </span>
                      </div>
                      <button 
                        onClick={() => setSelectedProductForSale(p)}
                        disabled={p.currentQuantity === 0}
                        className="bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 px-6 py-3 rounded-2xl font-bold flex items-center gap-2 hover:bg-neutral-800 dark:hover:bg-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      >
                        <TrendingDown className="w-4 h-4" />
                        Vender
                      </button>
                    </div>
                  </motion.div>
                ))}
              </div>
              
              {filteredProducts.length === 0 && (
                <div className="text-center py-20 bg-white dark:bg-neutral-900 rounded-3xl border border-dashed border-neutral-200 dark:border-neutral-800">
                  <Package className="w-12 h-12 text-neutral-200 dark:text-neutral-800 mx-auto mb-4" />
                  <p className="text-neutral-400">Nenhum produto encontrado.</p>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'ai' && (
            <motion.div
              key="ai"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-4xl mx-auto space-y-6"
            >
              {!aiPreviewData ? (
                <div className="bg-white dark:bg-neutral-900 p-8 rounded-3xl border border-neutral-200 dark:border-neutral-800 shadow-sm">
                  <div className="flex items-center gap-3 mb-6">
                    <Cpu className="w-6 h-6 text-neutral-900 dark:text-white" />
                    <h2 className="text-2xl font-bold">Importar Catálogo</h2>
                  </div>
                  <p className="text-neutral-500 dark:text-neutral-400 mb-6 text-sm leading-relaxed">
                    Cole o texto bruto do seu catálogo ou lista de peças. A IA identificará automaticamente códigos, categorias, materiais e valores.
                  </p>
                  
                  <textarea 
                    value={aiInput}
                    onChange={(e) => setAiInput(e.target.value)}
                    placeholder="Ex: ACESSORIOS 24691 47 47,00..."
                    className="w-full h-64 p-6 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-2xl focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:focus:ring-white/10 font-mono text-sm mb-6 resize-none text-neutral-900 dark:text-white"
                  />

                  {error && (
                    <div className="flex items-center gap-2 p-4 bg-red-50 text-red-600 rounded-xl mb-6 text-sm">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      {error}
                    </div>
                  )}

                  <button 
                    onClick={handleAIPreview}
                    disabled={isProcessingAI || !aiInput.trim()}
                    className="w-full bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 py-4 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-neutral-800 dark:hover:bg-neutral-100 disabled:opacity-50 transition-all"
                  >
                    {isProcessingAI ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Analisando dados...
                      </>
                    ) : (
                      <>
                        <Search className="w-5 h-5" />
                        Analisar Catálogo
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="bg-white dark:bg-neutral-900 p-8 rounded-3xl border border-neutral-200 dark:border-neutral-800 shadow-sm">
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 className="w-6 h-6 text-green-500" />
                        <h2 className="text-2xl font-bold">Confirmação de Dados</h2>
                      </div>
                      <button 
                        onClick={() => setAiPreviewData(null)}
                        className="text-sm text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
                      >
                        Voltar e Editar
                      </button>
                    </div>

                    <div className="bg-neutral-50 dark:bg-neutral-950 p-6 rounded-2xl mb-8">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-neutral-400 mb-4">Importação de Itens</h3>
                      <div className="p-4 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800">
                        <p className="font-bold text-neutral-900 dark:text-white">Adicionar ao Estoque</p>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">Os novos itens serão adicionados ou atualizados no estoque atual sem remover os existentes.</p>
                      </div>
                    </div>

                    <div className="overflow-x-auto border border-neutral-100 dark:border-neutral-800 rounded-2xl">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-neutral-50 dark:bg-neutral-950 text-neutral-400 font-bold uppercase text-[10px]">
                          <tr>
                            <th className="px-4 py-3">Código</th>
                            <th className="px-4 py-3">Categoria</th>
                            <th className="px-4 py-3">Material</th>
                            <th className="px-4 py-3 text-right">Qtd</th>
                            <th className="px-4 py-3 text-right">Valor</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                          {aiPreviewData.map((p, i) => (
                            <tr key={i}>
                              <td className="px-4 py-3 font-mono font-bold">{p.id}</td>
                              <td className="px-4 py-3">{p.category}</td>
                              <td className="px-4 py-3">{p.material}</td>
                              <td className="px-4 py-3 text-right">{p.initialQuantity}</td>
                              <td className="px-4 py-3 text-right font-bold">{p.unitValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <button 
                      onClick={commitAICatalog}
                      disabled={isProcessingAI}
                      className="w-full mt-8 bg-green-600 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-green-700 transition-all"
                    >
                      {isProcessingAI ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-5 h-5" />
                      )}
                      Confirmar e Salvar no Banco
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
                <h2 className="text-2xl font-bold">Histórico de Vendas</h2>
                <div className="relative w-full md:w-72">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
                  <input 
                    type="text"
                    placeholder="Filtrar por cliente ou código..."
                    value={historySearchTerm}
                    onChange={(e) => setHistorySearchTerm(e.target.value)}
                    className="w-full pl-11 pr-4 py-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:focus:ring-white/10 transition-all"
                  />
                </div>
              </div>

              <div className="bg-white dark:bg-neutral-900 rounded-3xl border border-neutral-200 dark:border-neutral-800 overflow-hidden shadow-sm">
                <div className="p-6 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
                  <h2 className="text-xl font-bold">Vendas Registradas</h2>
                  <History className="w-5 h-5 text-neutral-400" />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="bg-neutral-50 dark:bg-neutral-950 text-neutral-400 text-[10px] font-bold uppercase tracking-widest">
                        <th className="px-6 py-4">Data</th>
                        <th className="px-6 py-4">Código</th>
                        <th className="px-6 py-4">Categoria</th>
                        <th className="px-6 py-4 text-right">Valor</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {filteredSales.map((sale) => (
                        <tr key={sale.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
                          <td className="px-6 py-4 text-sm text-neutral-500 dark:text-neutral-400">
                            {format(new Date(sale.date), "dd/MM/yy HH:mm", { locale: ptBR })}
                          </td>
                          <td className="px-6 py-4 font-mono text-sm font-bold">{sale.productId}</td>
                          <td className="px-6 py-4 text-sm">
                            <div className="font-medium">{sale.category}</div>
                            <div className="text-xs text-neutral-400">
                              Cliente: {sale.customerName} • {sale.paymentMethod === 'cash' ? 'À Vista' : `Parcelado (${sale.paymentMethod})`}
                            </div>
                            {sale.installments && sale.installments.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {sale.installments.map((inst) => (
                                  <button
                                    key={inst.number}
                                    onClick={() => sale.id && toggleInstallmentStatus(sale.id, inst.number, inst.status)}
                                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold transition-all ${
                                      inst.status === 'paid' 
                                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' 
                                        : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                                    }`}
                                  >
                                    {inst.status === 'paid' ? <CheckCircle2 className="w-3 h-3" /> : <Circle className="w-3 h-3" />}
                                    {inst.number}ª ({format(new Date(inst.dueDate), "dd/MM")})
                                  </button>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4 text-right font-bold">
                            {sale.saleValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {filteredSales.length === 0 && (
                  <div className="p-12 text-center text-neutral-400">
                    Nenhuma venda encontrada.
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Sale Modal */}
      <AnimatePresence>
        {selectedProductForSale && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedProductForSale(null)}
              className="absolute inset-0 bg-neutral-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white dark:bg-neutral-900 w-full max-w-md rounded-3xl p-8 shadow-2xl"
            >
              <h2 className="text-2xl font-bold mb-2">Confirmar Venda</h2>
              <p className="text-neutral-500 dark:text-neutral-400 text-sm mb-6">
                Produto: <span className="font-bold text-neutral-900 dark:text-white">{selectedProductForSale.category} ({selectedProductForSale.id})</span>
              </p>

              <div className="space-y-4 mb-8">
                <div>
                  <label className="text-[10px] uppercase tracking-widest font-bold text-neutral-400 mb-2 block">
                    Nome do Cliente
                  </label>
                  <input 
                    autoFocus
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Digite o nome de quem comprou"
                    className="w-full px-4 py-3 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-neutral-900/10 dark:focus:ring-white/10 text-neutral-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase tracking-widest font-bold text-neutral-400 mb-2 block">
                    Forma de Pagamento
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setPaymentMethod('cash')}
                      className={`flex-1 py-3 rounded-xl border-2 font-bold text-sm transition-all ${
                        paymentMethod === 'cash'
                          ? 'border-neutral-900 dark:border-white bg-neutral-900 dark:bg-white text-white dark:text-neutral-900'
                          : 'border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-neutral-400'
                      }`}
                    >
                      À Vista
                    </button>
                    <button
                      onClick={() => setPaymentMethod('2x')}
                      className={`flex-1 py-3 rounded-xl border-2 font-bold text-sm transition-all ${
                        paymentMethod === '2x'
                          ? 'border-neutral-900 dark:border-white bg-neutral-900 dark:bg-white text-white dark:text-neutral-900'
                          : 'border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-neutral-400'
                      }`}
                    >
                      2x s/ Juros
                    </button>
                    <button
                      onClick={() => setPaymentMethod('3x')}
                      className={`flex-1 py-3 rounded-xl border-2 font-bold text-sm transition-all ${
                        paymentMethod === '3x'
                          ? 'border-neutral-900 dark:border-white bg-neutral-900 dark:bg-white text-white dark:text-neutral-900'
                          : 'border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-neutral-400'
                      }`}
                    >
                      3x s/ Juros
                    </button>
                  </div>
                </div>
                
                <div className="p-4 bg-neutral-50 dark:bg-neutral-950 rounded-xl">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm text-neutral-500 dark:text-neutral-400">Valor Total</span>
                    <span className="font-bold">{selectedProductForSale.unitValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
                  </div>
                  {paymentMethod !== 'cash' && (
                    <div className="flex justify-between items-center text-green-600 dark:text-green-400">
                      <span className="text-xs font-bold">Parcelas</span>
                      <span className="text-sm font-bold">
                        {paymentMethod} de {(selectedProductForSale.unitValue / (paymentMethod === '2x' ? 2 : 3)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={() => setSelectedProductForSale(null)}
                  className="flex-1 py-4 rounded-2xl font-bold text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
                >
                  Cancelar
                </button>
                <button 
                  onClick={handleSale}
                  disabled={!customerName.trim()}
                  className="flex-1 bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 py-4 rounded-2xl font-bold hover:bg-neutral-800 dark:hover:bg-neutral-100 disabled:opacity-50 transition-all"
                >
                  Finalizar Venda
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {/* Installment Toggle Confirmation */}
        {installmentToToggle && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setInstallmentToToggle(null)}
              className="absolute inset-0 bg-neutral-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white dark:bg-neutral-900 w-full max-w-sm rounded-3xl p-8 shadow-2xl text-center"
            >
              <div className={`w-16 h-16 rounded-full mx-auto mb-6 flex items-center justify-center ${
                installmentToToggle.currentStatus === 'pending' ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400' : 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'
              }`}>
                {installmentToToggle.currentStatus === 'pending' ? <CheckCircle2 className="w-8 h-8" /> : <AlertCircle className="w-8 h-8" />}
              </div>
              <h2 className="text-xl font-bold mb-2">
                {installmentToToggle.currentStatus === 'pending' ? 'Confirmar Pagamento?' : 'Retornar para Pendente?'}
              </h2>
              <p className="text-neutral-500 dark:text-neutral-400 text-sm mb-8">
                Deseja alterar o status da {installmentToToggle.installmentNumber}ª parcela para {installmentToToggle.currentStatus === 'pending' ? 'PAGO' : 'PENDENTE'}?
              </p>
              <div className="flex gap-4">
                <button 
                  onClick={() => setInstallmentToToggle(null)}
                  className="flex-1 py-4 rounded-2xl font-bold text-neutral-400 dark:text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-all"
                >
                  Não
                </button>
                <button 
                  onClick={confirmToggle}
                  className={`flex-1 py-4 rounded-2xl font-bold text-white transition-all ${
                    installmentToToggle.currentStatus === 'pending' ? 'bg-green-600 hover:bg-green-700' : 'bg-amber-600 hover:bg-amber-700'
                  }`}
                >
                  Sim
                </button>
              </div>
            </motion.div>
          </div>
        )}

        </AnimatePresence>

      {/* Mobile Nav Overlay (Optional if tabs are enough) */}
    </div>
  );
}
